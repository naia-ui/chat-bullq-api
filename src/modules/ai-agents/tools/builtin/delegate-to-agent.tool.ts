import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * ORCHESTRATOR-only. Hands the conversation over to a WORKER agent in a
 * single atomic call:
 *   1. (optional but strongly recommended) sends a transition message to
 *      the customer ("aqui é o X, vou te passar pra Y, ela cuida disso");
 *   2. flips `conversation.activeAgentId` to the worker;
 *   3. logs an AiAgentHandoff record + audit log.
 *
 * Bundling the transition message inside the same tool prevents the LLM
 * from announcing "vou te passar pra X" via replyToConversation and then
 * forgetting to actually call delegateToAgent — which would leave the
 * customer hanging waiting for the worker that never gets activated.
 *
 * After this tool runs, the auto-chain in AgentRunnerService picks up the
 * new active agent and fires the worker run immediately.
 */
@Injectable()
export class DelegateToAgentTool implements AiTool {
  private readonly logger = new Logger(DelegateToAgentTool.name);

  readonly name = 'delegateToAgent';
  readonly description =
    'Encaminha a conversa pra um especialista em UMA chamada atômica. Inclua transitionMessage com a fala curta que o cliente vê ANTES de você sair de cena. NUNCA use replyToConversation antes disso pra anunciar a transferência — sempre passe a mensagem aqui dentro.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['agentId', 'reason', 'transitionMessage'],
    properties: {
      agentId: {
        type: 'string',
        description:
          'O ID exato do agente especialista (vem da resposta de listAvailableAgents.agents[].agentId).',
      },
      reason: {
        type: 'string',
        description:
          'Por que esse worker? Uma frase curta. Ex: "Cliente perdeu acesso à área de membros".',
        maxLength: 300,
      },
      transitionMessage: {
        type: 'string',
        description:
          'A mensagem curta enviada AO CLIENTE anunciando a transferência (ex: "show, vou te passar pra Lívia, ela cuida de acesso e resolve em segundos"). Tom humano, sem travessão "—" nem en-dash "–", sem markdown.',
        minLength: 1,
        maxLength: 600,
      },
      briefing: {
        type: 'string',
        description:
          'Resumo do contexto que você já levantou pra que o worker comece adiantado. Inclua o que o cliente disse, dores percebidas, info já coletada (email, telefone, etc). Texto corrido, sem markdown.',
        maxLength: 1500,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const targetAgentId = String(input.agentId ?? '').trim();
    const reason = String(input.reason ?? '').trim();
    const transitionMessage = String(input.transitionMessage ?? '').trim();
    const briefing = input.briefing ? String(input.briefing).trim() : null;

    if (!targetAgentId) {
      return { output: { ok: false, error: 'agentId is required' } };
    }
    if (!transitionMessage) {
      return {
        output: {
          ok: false,
          error:
            'transitionMessage is required — sem mensagem de transição o cliente fica sem saber que houve handoff',
        },
      };
    }

    const target = await this.prisma.aiAgent.findFirst({
      where: {
        id: targetAgentId,
        organizationId: ctx.organizationId,
        isActive: true,
        deletedAt: null,
      },
      select: { id: true, name: true, kind: true },
    });

    if (!target) {
      return {
        output: {
          ok: false,
          error: `Agent ${targetAgentId} not found in this organization or is inactive`,
        },
      };
    }

    if (target.kind !== 'WORKER') {
      return {
        output: {
          ok: false,
          error: `Cannot delegate to ${target.name}: only WORKER agents accept delegation.`,
        },
      };
    }

    const [fromAgent, contactChannel] = await Promise.all([
      this.prisma.aiAgent.findUnique({
        where: { id: ctx.agentId },
        select: { name: true },
      }),
      this.prisma.contactChannel.findFirst({
        where: { contactId: ctx.contactId, channelId: ctx.channelId },
        select: { externalId: true },
      }),
    ]);

    if (!contactChannel?.externalId) {
      return {
        output: {
          ok: false,
          error: 'Contact has no external id on this channel',
        },
      };
    }

    // Atomic: send transition message + flip active agent + log handoff.
    const [message] = await this.prisma.$transaction([
      this.prisma.message.create({
        data: {
          conversationId: ctx.conversationId,
          direction: MessageDirection.OUTBOUND,
          type: MessageContentType.TEXT,
          content: { text: transitionMessage },
          status: MessageStatus.QUEUED,
          senderName: fromAgent?.name ?? 'AI',
          metadata: {
            aiAgentId: ctx.agentId,
            runId: ctx.runId,
            handoffTransition: true,
          },
        },
      }),
      this.prisma.conversation.update({
        where: { id: ctx.conversationId },
        data: { activeAgentId: target.id, lastMessageAt: new Date() },
      }),
      this.prisma.aiAgentHandoff.create({
        data: {
          conversationId: ctx.conversationId,
          fromAgentId: ctx.agentId,
          toAgentId: target.id,
          reason,
          briefing,
        },
      }),
      this.prisma.conversationAuditLog.create({
        data: {
          conversationId: ctx.conversationId,
          actorId: null,
          action: 'AI_DELEGATED',
          metadata: {
            fromAgentId: ctx.agentId,
            toAgentId: target.id,
            reason,
            runId: ctx.runId,
          },
        },
      }),
    ]);

    // Realtime + outbound queue happen after the transaction commits.
    this.realtime.emitToChannel(ctx.channelId, 'message:new', {
      message,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
    });
    this.realtime.emitToConversation(ctx.conversationId, 'message:new', {
      message,
    });
    this.realtime.emitToConversation(
      ctx.conversationId,
      'conversation:ai-delegated',
      {
        conversationId: ctx.conversationId,
        toAgentId: target.id,
        toAgentName: target.name,
        reason,
      },
    );

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: ctx.channelId,
        contactExternalId: contactChannel.externalId,
        message: {
          type: MessageContentType.TEXT,
          content: { text: transitionMessage },
        },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Orchestrator ${ctx.agentId} delegated conv ${ctx.conversationId} → ${target.name} (${target.id}): ${reason}`,
    );

    return {
      output: {
        ok: true,
        delegatedTo: { agentId: target.id, name: target.name },
        transitionMessageId: message.id,
        message:
          'Delegação concluída. A mensagem de transição foi enviada e o worker já assumiu — o run dele dispara em sequência automaticamente.',
      },
      finalAction: 'DELEGATED',
    };
  }
}
