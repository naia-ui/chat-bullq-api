import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { ConfigService } from '@nestjs/config';
import {
  ChannelType,
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { ZappfyOutboundAdapter } from '../../channel-hub/adapters/zappfy/zappfy.outbound-adapter';
// `MessageContentType` do channel-hub (normalized-message.types.ts) é um
// enum DIFERENTE do `@prisma/client` (mesmos nomes, tipos nominalmente
// incompatíveis) — usado só na chamada direta a `outbound.sendMessage()`,
// que espera o tipo normalizado do adapter, não o do banco.
import { MessageContentType as NormalizedMessageContentType } from '../../channel-hub/ports/types';
import { isWithinBusinessHours } from '../router/business-hours.util';
import {
  DEFAULT_HANDOFF_OUT_OF_HOURS_MESSAGE,
  HUMAN_SUPPORT_HOURS,
} from './human-support-hours.constants';

// Não repete o aviso de fora-de-horário nem o ping interno pra mesma
// conversa dentro dessa janela — evita spam se a IA chamar transferToHuman
// mais de uma vez na mesma madrugada de conversa parada.
const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Dois avisos disparados no momento em que um handoff pra humano é
 * executado de verdade (`HandoffExecutionService.execute`):
 *
 *  1. `notifyClientIfOutsideHumanHours` — pro CLIENTE, só fora do horário de
 *     atendimento humano (`HUMAN_SUPPORT_HOURS`). A IA (Justine) continua
 *     respondendo 24/7 normalmente; esse aviso só avisa que a parte humana
 *     (agendamento, atendimento pessoal) vai esperar o expediente.
 *
 *  2. `alertInternalTeam` — pro TIME interno (Paula, João, etc.), via
 *     WhatsApp direto pro celular de cada um, "tem gente esperando, olha o
 *     sistema" — dispara sempre que há handoff, dentro ou fora do horário.
 */
@Injectable()
export class HandoffNotificationsService {
  private readonly logger = new Logger(HandoffNotificationsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    private readonly config: ConfigService,
    private readonly zappfyOutbound: ZappfyOutboundAdapter,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async notifyClientIfOutsideHumanHours(conversationId: string): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        include: { organization: { select: { aiTimezone: true } } },
      });
      if (!conversation) return;

      const withinHumanHours = isWithinBusinessHours(
        HUMAN_SUPPORT_HOURS,
        conversation.organization.aiTimezone,
      );
      if (withinHumanHours) return; // dentro do horário — humano já vai ver rápido, sem aviso extra.

      const recentNotice = await this.prisma.message.findFirst({
        where: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
        },
        orderBy: { createdAt: 'desc' },
        select: { metadata: true },
      });
      if (
        (recentNotice?.metadata as Record<string, unknown> | null)
          ?.handoffOutOfHoursNotice === true
      ) {
        return; // já avisou recentemente pra essa conversa.
      }

      const contactChannel = await this.prisma.contactChannel.findFirst({
        where: {
          contactId: conversation.contactId,
          channelId: conversation.channelId,
        },
        select: { externalId: true },
      });
      if (!contactChannel?.externalId) {
        this.logger.warn(
          `Handoff out-of-hours notice: conv ${conversationId} sem contactChannel externalId — pulado`,
        );
        return;
      }

      const text = DEFAULT_HANDOFF_OUT_OF_HOURS_MESSAGE;

      const message = await this.prisma.message.create({
        data: {
          conversationId,
          direction: MessageDirection.OUTBOUND,
          type: MessageContentType.TEXT,
          content: { text },
          status: MessageStatus.QUEUED,
          senderName: 'AI',
          metadata: { handoffOutOfHoursNotice: true },
        },
      });

      await this.prisma.conversation.update({
        where: { id: conversationId },
        data: { lastMessageAt: new Date() },
      });

      this.realtime.emitToChannel(conversation.channelId, 'message:new', {
        message,
        conversationId,
        contactId: conversation.contactId,
      });
      this.realtime.emitToConversation(conversationId, 'message:new', {
        message,
      });

      await this.outboundQueue.add(
        'send-outbound',
        {
          messageId: message.id,
          channelId: conversation.channelId,
          contactExternalId: contactChannel.externalId,
          message: { type: MessageContentType.TEXT, content: { text } },
        },
        {
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
          removeOnComplete: true,
          removeOnFail: false,
        },
      );

      this.logger.log(
        `Handoff out-of-hours notice sent to client on conv ${conversationId}`,
      );
    } catch (err: any) {
      // Best-effort: falha aqui nunca pode derrubar o handoff em si.
      this.logger.warn(
        `Failed to send handoff out-of-hours notice for conv ${conversationId}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Ping interno via WhatsApp direto (não passa pela fila/pipeline de
   * conversa com cliente — é uma mensagem avulsa pro celular de cada
   * pessoa do time, usando o mesmo canal/número do escritório).
   *
   * Números somam DUAS fontes:
   *  - `HANDOFF_ALERT_WHATSAPP_NUMBERS` (env, fixos, separados por vírgula,
   *    formato DDI+DDD+número) — sempre avisados, qualquer área.
   *  - `AiAgent.handoffAlertPhone` do agente que pediu o handoff — pensado
   *    pra plantão que muda (ex: hoje trabalhista é a Paula, amanhã o
   *    João — só editar o campo do agente, sem mexer em env/deploy).
   *
   * Sem nenhuma das duas configuradas, só loga aviso e não manda nada.
   */
  async alertInternalTeam(
    conversationId: string,
    contactName: string,
    reason: string | null,
    agentId?: string,
  ): Promise<void> {
    try {
      const fixedNumbersRaw = this.config.get<string>(
        'HANDOFF_ALERT_WHATSAPP_NUMBERS',
      );
      const fixedNumbers = (fixedNumbersRaw ?? '')
        .split(',')
        .map((n) => n.trim())
        .filter(Boolean);

      const agentPhone = agentId
        ? (
            await this.prisma.aiAgent.findUnique({
              where: { id: agentId },
              select: { handoffAlertPhone: true },
            })
          )?.handoffAlertPhone?.trim()
        : null;

      // Normaliza ANTES de deduplicar — sem isso, "48991946004" e
      // "5548991946004" contam como números diferentes em vez de colapsar
      // no mesmo. Achado em produção (22/08/2026): número sem DDI falha
      // calado no Zappfy (nem erro, nem entrega) — normalizar aqui é bem
      // mais seguro que confiar em todo mundo lembrar de digitar o 55.
      const numbers = [
        ...new Set(
          [...fixedNumbers, ...(agentPhone ? [agentPhone] : [])]
            .map((n) => this.normalizePhoneNumber(n))
            .filter(Boolean),
        ),
      ];

      if (numbers.length === 0) {
        this.logger.warn(
          'Nem HANDOFF_ALERT_WHATSAPP_NUMBERS nem handoffAlertPhone do agente configurados — ping interno de handoff não enviado.',
        );
        return;
      }

      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { channelId: true, organizationId: true },
      });
      if (!conversation) return;

      const channel = await this.prisma.channel.findFirst({
        where: {
          id: conversation.channelId,
          type: ChannelType.WHATSAPP_ZAPPFY,
          isActive: true,
          deletedAt: null,
        },
      });
      if (!channel) {
        this.logger.warn(
          `Handoff internal alert: canal ${conversation.channelId} não é WHATSAPP_ZAPPFY ativo — pulado`,
        );
        return;
      }

      const text =
        `🔔 Tem mensagem no sistema — *${contactName}* está aguardando ` +
        `atendimento humano${reason ? ` (${reason})` : ''}. Dá uma olhada: ` +
        `https://app.justinelegal.com.br/inbox`;

      for (const number of numbers) {
        try {
          await this.zappfyOutbound.sendMessage(channel, number, {
            type: NormalizedMessageContentType.TEXT,
            content: { text },
          });
        } catch (err: any) {
          this.logger.warn(
            `Falha ao mandar ping interno de handoff pra ${number}: ${err?.message ?? err}`,
          );
        }
      }
      this.logger.log(
        `Handoff internal alert sent to ${numbers.length} number(s) for conv ${conversationId}`,
      );
    } catch (err: any) {
      this.logger.warn(
        `Failed to alert internal team for conv ${conversationId}: ${err?.message ?? err}`,
      );
    }
  }

  /**
   * Garante DDI 55 num número brasileiro que só tem DDD+número (10 ou 11
   * dígitos). Já com 55 na frente (12-13 dígitos) mantém como está.
   * Formato irreconhecível (nem 10-11 nem 12-13 dígitos) passa direto —
   * deixa o provider rejeitar explicitamente em vez de inventar prefixo
   * errado pra número de outro país.
   */
  private normalizePhoneNumber(raw: string): string {
    const digits = raw.replace(/\D/g, '');
    if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
      return digits;
    }
    if (digits.length === 10 || digits.length === 11) {
      return `55${digits}`;
    }
    return digits;
  }
}
