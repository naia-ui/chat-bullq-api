import { Injectable, Logger } from '@nestjs/common';
import { Conversation } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { IntentClassifierService } from '../classifier/intent-classifier.service';
import { IntentRouterService } from '../classifier/intent-router.service';
import type {
  ClassificationResult,
  ClassifierMessage,
} from '../classifier/intent.types';
import { IntentType } from '../classifier/intent.types';
import { isWithinBusinessHours } from './business-hours.util';

export interface AgentSelection {
  agentId: string;
  agentName: string;
  classifiedIntent: string | null;
  classifierConfidence: number | null;
  skippedOrchestrator: boolean;
  classifierCostUsd: number;
}

/**
 * Nome exato do agente WORKER de atendimento a cliente já existente —
 * precisa ser criado manualmente na tela de Agentes com esse nome literal
 * (mesma convenção de `IntentRouterService.MAP`, que já espera "Justine"
 * pro orquestrador). Sem esse agente cadastrado, o bypass simplesmente não
 * encontra ninguém e o roteamento cai no fluxo normal — nunca trava o
 * atendimento por falta de configuração.
 */
export const EXISTING_CLIENT_AGENT_NAME = 'Justine Clientes';

@Injectable()
export class AgentRouterService {
  private readonly logger = new Logger(AgentRouterService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly classifier: IntentClassifierService,
    private readonly intentRouter: IntentRouterService,
  ) {}

  /**
   * Resolve qual agente vai atender essa mensagem.
   *
   * Regras:
   * 1. Se a conversa já tem `activeAgentId` (continuação de conversa em andamento) →
   *    usa ele direto, sem classificar (evita re-roteamento no meio do papo).
   * 2. Se for primeira mensagem (sem activeAgentId) → chama IntentClassifier
   *    (Fugu cheap/simple-model path). Se confidence >= threshold e o intent for
   *    direcionável, pula o orchestrator e vai direto pro worker.
   * 3. Fallback: cai no orchestrator AUTONOMOUS do canal (Augusto).
   */
  async selectAgent(
    conversation: Conversation,
    latestMessageText: string,
    recentMessages: ClassifierMessage[] = [],
  ): Promise<AgentSelection | null> {
    // 1. Conversa em andamento — mantém o agent atual
    if (conversation.activeAgentId) {
      const agent = await this.prisma.aiAgent.findUnique({
        where: { id: conversation.activeAgentId },
        select: { id: true, name: true },
      });
      if (agent) {
        return {
          agentId: agent.id,
          agentName: agent.name,
          classifiedIntent: null,
          classifierConfidence: null,
          skippedOrchestrator: false,
          classifierCostUsd: 0,
        };
      }
    }

    // 1.5. Cliente já existente (card GANHO em qualquer pipeline OU tag
    // manual "cliente-existente") → vai direto pro atendimento de cliente,
    // sem gastar chamada de classificador nem passar pela triagem por área
    // (quem já é cliente não precisa re-explicar em qual área se encaixa).
    const existingClientAgent = await this.findExistingClientAgent(
      conversation,
    );
    if (existingClientAgent) {
      this.logger.log({
        msg: 'agent_selected_existing_client',
        agentName: existingClientAgent.name,
        contactId: conversation.contactId,
      });
      return {
        agentId: existingClientAgent.id,
        agentName: existingClientAgent.name,
        classifiedIntent: 'EXISTING_CLIENT',
        classifierConfidence: 1,
        skippedOrchestrator: true,
        classifierCostUsd: 0,
      };
    }

    // 2. Carrega threshold da org
    const org = await this.prisma.organization.findUnique({
      where: { id: conversation.organizationId },
      select: { aiClassifierThreshold: true },
    });
    const threshold = org?.aiClassifierThreshold
      ? Number(org.aiClassifierThreshold)
      : 0.85;

    // 3. Classifica
    let classification: ClassificationResult;
    try {
      classification = await this.classifier.classify(
        latestMessageText,
        recentMessages,
        { threshold },
      );
    } catch (err) {
      this.logger.warn({
        msg: 'classifier_failed_fallback_orchestrator',
        error: (err as Error).message,
      });
      return this.fallbackToOrchestrator(conversation);
    }

    // 4. Se confidence alta e intent direcionável → vai direto pro worker
    if (
      classification.skippedOrchestrator &&
      classification.suggestedAgent &&
      classification.intent !== IntentType.AMBIGUOUS &&
      classification.intent !== IntentType.SMALL_TALK
    ) {
      const agent = await this.prisma.aiAgent.findFirst({
        where: {
          organizationId: conversation.organizationId,
          name: classification.suggestedAgent,
          isActive: true,
          deletedAt: null,
        },
        select: { id: true, name: true },
      });
      if (agent) {
        this.logger.log({
          msg: 'agent_selected_via_classifier',
          intent: classification.intent,
          confidence: classification.confidence,
          agentName: agent.name,
          costUsd: classification.costUsd,
        });
        return {
          agentId: agent.id,
          agentName: agent.name,
          classifiedIntent: classification.intent,
          classifierConfidence: classification.confidence,
          skippedOrchestrator: true,
          classifierCostUsd: classification.costUsd,
        };
      }
      this.logger.warn({
        msg: 'classifier_suggested_agent_not_found',
        suggested: classification.suggestedAgent,
      });
    }

    // 5. Fallback pro orchestrator
    const fallback = await this.fallbackToOrchestrator(conversation);
    if (fallback) {
      fallback.classifiedIntent = classification.intent;
      fallback.classifierConfidence = classification.confidence;
      fallback.classifierCostUsd = classification.costUsd;
    }
    return fallback;
  }

  /**
   * Retorna o agente "Justine Clientes" se (a) ele existir e estiver ativo
   * na org E (b) o contato dessa conversa já for cliente — card com
   * status GANHO em qualquer pipeline, ou tag manual "cliente-existente".
   * Sem o agente cadastrado ou sem sinal de cliente existente, retorna
   * null e o roteamento normal por área segue intocado.
   */
  private async findExistingClientAgent(
    conversation: Conversation,
  ): Promise<{ id: string; name: string } | null> {
    const [agent, wonCard, existingClientTag] = await Promise.all([
      this.prisma.aiAgent.findFirst({
        where: {
          organizationId: conversation.organizationId,
          name: EXISTING_CLIENT_AGENT_NAME,
          kind: 'WORKER',
          isActive: true,
          deletedAt: null,
        },
        select: { id: true, name: true },
      }),
      this.prisma.card.findFirst({
        where: {
          organizationId: conversation.organizationId,
          contactId: conversation.contactId,
          status: 'WON',
        },
        select: { id: true },
      }),
      this.prisma.contactTag.findFirst({
        where: {
          contactId: conversation.contactId,
          tag: {
            organizationId: conversation.organizationId,
            name: 'cliente-existente',
          },
        },
        select: { contactId: true },
      }),
    ]);

    if (!agent) return null; // "Justine Clientes" ainda não foi criada na org.
    if (!wonCard && !existingClientTag) return null; // não é cliente conhecido.
    return agent;
  }

  private async fallbackToOrchestrator(
    conversation: Conversation,
  ): Promise<AgentSelection | null> {
    // kind: ORCHESTRATOR é obrigatório — sem esse filtro o findFirst
    // devolvia um worker arbitrário do canal (visto em prod: Daniel
    // recebendo small talk/spam/fallback que era do Augusto).
    let link = await this.prisma.aiAgentChannel.findFirst({
      where: {
        channelId: conversation.channelId,
        mode: 'AUTONOMOUS',
        agent: { isActive: true, deletedAt: null, kind: 'ORCHESTRATOR' },
      },
      include: {
        agent: { select: { id: true, name: true } },
      },
    });
    if (!link) {
      // Canal sem orquestrador vinculado: melhor um worker qualquer
      // do que ninguém responder.
      link = await this.prisma.aiAgentChannel.findFirst({
        where: {
          channelId: conversation.channelId,
          mode: 'AUTONOMOUS',
          agent: { isActive: true, deletedAt: null },
        },
        include: {
          agent: { select: { id: true, name: true } },
        },
      });
    }
    if (!link?.agent) {
      this.logger.warn({
        msg: 'no_orchestrator_for_channel',
        channelId: conversation.channelId,
      });
      return null;
    }
    return {
      agentId: link.agent.id,
      agentName: link.agent.name,
      classifiedIntent: null,
      classifierConfidence: null,
      skippedOrchestrator: false,
      classifierCostUsd: 0,
    };
  }

  /**
   * Decides whether the AI should react to an inbound message. Returns
   * `null` if it should not, or the resolved active agent for the run.
   * The runner does the actual execution.
   */
  async shouldHandle(conversation: Conversation): Promise<{
    handle: boolean;
    reason?: string;
  }> {
    // Hierarquia de override (mais específico ganha):
    //   conv.aiEnabled (true/false) — força resposta da conversa específica
    //   channel.aiEnabled (true/false) — força no canal inteiro
    //   org.aiEnabled (true/false) — global
    // Qualquer "false" mais específico bloqueia mesmo se mais genérico está ON.
    // "true" mais específico libera mesmo se mais genérico está OFF.
    const convOverride = conversation.aiEnabled;

    if (convOverride === false) {
      return { handle: false, reason: 'conversation.aiEnabled=force-off' };
    }

    // Carrega channel + org pra cascade de checks.
    const [channel, org] = await Promise.all([
      this.prisma.channel.findUnique({
        where: { id: conversation.channelId },
        select: { aiEnabled: true },
      }),
      this.prisma.organization.findUnique({
        where: { id: conversation.organizationId },
      }),
    ]);
    if (!org) return { handle: false, reason: 'org-not-found' };

    const channelOverride = channel?.aiEnabled;
    if (convOverride !== true && channelOverride === false) {
      return { handle: false, reason: 'channel.aiEnabled=force-off' };
    }

    if (convOverride !== true && channelOverride !== true) {
      // Sem override "ON" em conv nem channel → regra global vale.
      if (!org.aiEnabled) {
        return { handle: false, reason: 'org.aiEnabled=false' };
      }
      // Gate de horário restaurado em 22/08/2026 (raio-x item 4): a tela
      // de Configurações → IA já tinha o toggle "Atendimento 24/7" +
      // grade de horário havia anos, mas o backend ignorava esse campo de
      // propósito — quem desligasse 24/7 não via efeito nenhum. `null` em
      // `org.aiBusinessHours` continua significando 24/7 (comportamento
      // atual preservado por padrão); só passa a restringir se alguém
      // configurar uma janela específica na tela. Quando bloqueia aqui,
      // `inbound-message.processor.ts` já sabe tratar o motivo
      // 'outside-business-hours' mandando `org.aiOutOfHoursMessage`
      // automaticamente (OutOfHoursReplyService) — nada mais precisou
      // mudar pra essa cadeia religar.
      if (!isWithinBusinessHours(org.aiBusinessHours, org.aiTimezone)) {
        return { handle: false, reason: 'outside-business-hours' };
      }
    }

    // Mesmo com override pra ON, ainda precisa existir um agente ativo
    // pra atender essa conversa. Sem isso, não tem o que rodar.
    if (!conversation.activeAgentId) {
      const link = await this.prisma.aiAgentChannel.findFirst({
        where: {
          channelId: conversation.channelId,
          mode: 'AUTONOMOUS',
          agent: { isActive: true, deletedAt: null },
        },
      });
      if (!link) {
        return { handle: false, reason: 'no-agent-for-channel' };
      }
    }

    // Cap mensal vale sempre — proteção de orçamento, não dá pra furar.
    if (org.aiMonthlyTokenCap) {
      const startOfMonth = new Date();
      startOfMonth.setDate(1);
      startOfMonth.setHours(0, 0, 0, 0);

      const used = await this.prisma.aiAgentRun.aggregate({
        where: {
          organizationId: org.id,
          startedAt: { gte: startOfMonth },
        },
        _sum: { inputTokens: true, outputTokens: true },
      });
      const total =
        (used._sum.inputTokens ?? 0) + (used._sum.outputTokens ?? 0);
      if (total >= org.aiMonthlyTokenCap) {
        return { handle: false, reason: 'monthly-token-cap-reached' };
      }
    }

    return { handle: true };
  }
}
