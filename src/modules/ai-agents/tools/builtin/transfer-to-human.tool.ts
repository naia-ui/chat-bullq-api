import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { PendingActionService } from '../../confirmations/pending-action.service';
import { ZappfyHttpClient } from '../../../channel-hub/adapters/zappfy/zappfy.http-client';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Hands the conversation off to a human. Pauses AI on this conversation
 * (so the agent stops responding), moves status to PENDING (so it shows
 * up in the queue), and clears the active agent.
 *
 * Fase 2: a operação real ficou atrás de aprovação humana. A tool agora
 * cria um `PendingAction` (impact=critical) e devolve `requiresUserAction`
 * pro LLM. Quando aprovada, o executor da fase 2 faz o pause/handoff de
 * verdade. Mantemos a notificação imediata pro operador (via realtime)
 * pra ele revisar a fila de pendências sem demora.
 *
 * Além do realtime (só visível com o painel aberto), manda um alerta de
 * WhatsApp best-effort pro número configurado em `LEGAL_HANDOFF_WHATSAPP_NUMBER`
 * — pra alguém saber que precisa entrar no painel mesmo longe do computador.
 * Falha nesse envio nunca derruba o handoff em si (só loga um warning).
 */
@Injectable()
export class TransferToHumanTool implements AiTool {
  private readonly logger = new Logger(TransferToHumanTool.name);

  readonly name = 'transferToHuman';
  readonly description =
    'Hand the conversation over to a human agent. Use this when: the request is outside your competence, the customer explicitly asks for a person, the situation is sensitive (complaint, refund, anger), or you are uncertain. The conversation will move to the queue and AI will be paused.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description:
          'Short reason for the handoff, in PT-BR. Visible to the human as an internal note. e.g., "Cliente pediu reembolso, fora do meu escopo".',
        minLength: 3,
        maxLength: 500,
      },
      summary: {
        type: 'string',
        description:
          'Optional short summary of the conversation so far so the human picks up faster.',
        maxLength: 1000,
      },
    },
  };

  constructor(
    private readonly realtime: RealtimeGateway,
    private readonly pendingActions: PendingActionService,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly zappfyHttpClient: ZappfyHttpClient,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason = String(input.reason ?? '').trim() || 'Handoff sem motivo informado';
    const summary = input.summary ? String(input.summary).trim() : null;

    const preview = {
      action: `Transferir conversa pro atendimento humano: ${reason}`,
      impact: 'critical' as const,
      rollback:
        'Reativar IA na conversa (aiEnabled=true) e devolver pra fila do bot.',
      affectedEntity: {
        type: 'conversation' as const,
        id: ctx.conversationId,
        label: `conversation:${ctx.conversationId}`,
      },
    };

    const action = await this.pendingActions.create({
      agentRunId: ctx.runId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      toolName: this.name,
      args: { reason, summary },
      preview,
    });

    // Notifica o operador imediatamente — ele revisa a fila de pendências
    // e aprova/rejeita. A pausa da IA acontece SOMENTE após aprovação,
    // pelo executor da fase 2.
    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:pending-action',
      {
        conversationId: ctx.conversationId,
        pendingActionId: action.id,
        toolName: this.name,
        impact: preview.impact,
        reason,
      },
    );

    this.logger.log(
      `Agent ${ctx.agentId} requested handoff for conv ${ctx.conversationId} → pendingAction=${action.id} (reason="${reason}")`,
    );

    await this.sendWhatsappAlert(ctx, reason, summary);

    return {
      output: {
        ok: true,
        status: 'queued_for_processing',
        pendingActionId: action.id,
        preview,
        message:
          'Transferência registrada com sucesso. Atendente humano vai assumir em instantes — fluxo padrão, não é erro.',
        agent_should_say:
          'Avise o cliente, com naturalidade, que um atendente humano vai continuar o atendimento agora. NÃO mencione "aprovação", "operador", "PendingAction" ou qualquer detalhe interno.',
      },
      // Mantém o sinal de "saí do loop" — o agent deve parar de responder
      // até o operador decidir. Sem isso o LLM seguiria conversando como
      // se tivesse transferido de fato.
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }

  /**
   * Alerta best-effort de WhatsApp pro time jurídico. Só roda se
   * `LEGAL_HANDOFF_WHATSAPP_NUMBER` estiver configurado e o canal da
   * conversa for Zappfy (única forma de envio implementada hoje). Qualquer
   * falha aqui é só logada — nunca deve derrubar o handoff em si.
   */
  private async sendWhatsappAlert(
    ctx: ToolContext,
    reason: string,
    summary: string | null,
  ): Promise<void> {
    const alertNumber = this.config.get<string>('LEGAL_HANDOFF_WHATSAPP_NUMBER');
    if (!alertNumber) return;

    try {
      const channel = await this.prisma.channel.findUnique({
        where: { id: ctx.channelId },
      });
      if (!channel || channel.type !== ChannelType.WHATSAPP_ZAPPFY) {
        this.logger.debug(
          `Skipping WhatsApp handoff alert — channel ${ctx.channelId} is not WHATSAPP_ZAPPFY`,
        );
        return;
      }

      const contact = await this.prisma.contact.findUnique({
        where: { id: ctx.contactId },
        select: { name: true, phone: true },
      });

      const appUrl = this.config.get<string>('APP_URL') ?? '';
      const webUrl = appUrl.includes('api.') ? appUrl.replace('api.', 'app.') : appUrl;
      const link = webUrl
        ? `${webUrl}/inbox?conversationId=${ctx.conversationId}`
        : ctx.conversationId;

      const contactLabel = contact?.name || contact?.phone || 'cliente';
      const lines = [
        'Transferência solicitada pela Justine.',
        `Cliente: ${contactLabel}`,
        `Motivo: ${reason}`,
        ...(summary ? [`Resumo: ${summary}`] : []),
        `Abrir conversa: ${link}`,
      ];

      await this.zappfyHttpClient.sendRequest(channel, '/send/text', {
        number: alertNumber,
        text: lines.join('\n'),
        delay: 1000,
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to send WhatsApp handoff alert to ${alertNumber}: ${err?.message ?? err}`,
      );
    }
  }
}
