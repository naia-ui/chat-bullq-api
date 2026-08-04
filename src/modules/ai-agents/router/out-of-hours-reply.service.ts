import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  Conversation,
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';

const DEFAULT_OUT_OF_HOURS_MESSAGE =
  'Obrigado pelo contato! No momento estamos fora do horário de atendimento. Recebemos sua mensagem e retornaremos assim que possível, no próximo dia útil.';

// Não repete o aviso pra mesma conversa dentro dessa janela — evita mandar o
// mesmo "fora do horário" a cada mensagem que o cliente envia na mesma
// madrugada/fim de semana.
const DEDUPE_WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Fora do horário comercial o AgentRouterService bloqueia o agente de IA por
 * completo (não gasta tokens rodando o LLM à toa fora de horário). Isso não
 * pode significar silêncio total pro cliente: em vez de rodar o agente,
 * manda um aviso automático curto avisando que a resposta completa vem no
 * próximo dia útil.
 */
@Injectable()
export class OutOfHoursReplyService {
  private readonly logger = new Logger(OutOfHoursReplyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  /**
   * Envia o aviso de fora-de-horário se ainda não foi enviado recentemente
   * pra essa conversa. Retorna true se mandou uma mensagem nova.
   */
  async maybeReply(conversation: Conversation): Promise<boolean> {
    const lastMessage = await this.prisma.message.findFirst({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' },
    });
    // Só reage se a última mensagem é do cliente e ainda não foi respondida
    // — se já é nossa (inclusive um aviso anterior), não tem o que fazer.
    if (!lastMessage || lastMessage.direction !== MessageDirection.INBOUND) {
      return false;
    }

    const recentAutoReply = await this.prisma.message.findFirst({
      where: {
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        createdAt: { gte: new Date(Date.now() - DEDUPE_WINDOW_MS) },
      },
      orderBy: { createdAt: 'desc' },
      select: { metadata: true },
    });
    if (
      (recentAutoReply?.metadata as Record<string, unknown> | null)
        ?.outOfHoursAutoReply === true
    ) {
      return false;
    }

    const [org, contactChannel] = await Promise.all([
      this.prisma.organization.findUnique({
        where: { id: conversation.organizationId },
        select: { aiOutOfHoursMessage: true },
      }),
      this.prisma.contactChannel.findFirst({
        where: {
          contactId: conversation.contactId,
          channelId: conversation.channelId,
        },
        select: { externalId: true },
      }),
    ]);
    if (!contactChannel?.externalId) {
      this.logger.warn(
        `Cannot send out-of-hours reply on conv ${conversation.id}: no contactChannel externalId`,
      );
      return false;
    }

    const text =
      org?.aiOutOfHoursMessage?.trim() || DEFAULT_OUT_OF_HOURS_MESSAGE;

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text },
        status: MessageStatus.QUEUED,
        senderName: 'AI',
        metadata: { outOfHoursAutoReply: true },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });

    this.realtime.emitToChannel(conversation.channelId, 'message:new', {
      message,
      conversationId: conversation.id,
      contactId: conversation.contactId,
    });
    this.realtime.emitToConversation(conversation.id, 'message:new', {
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

    this.logger.log(`Sent out-of-hours auto-reply on conv ${conversation.id}`);
    return true;
  }
}
