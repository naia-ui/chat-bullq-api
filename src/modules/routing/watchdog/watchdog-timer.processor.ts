import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, forwardRef, Inject } from '@nestjs/common';
import { Job } from 'bullmq';
import {
  ConversationStatus,
  MessageDirection,
  NotificationType,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { AiAgentRunnerService } from '../../ai-agents/runner/agent-runner.service';
import { AgentRouterService } from '../../ai-agents/router/agent-router.service';
import { OutOfHoursReplyService } from '../../ai-agents/router/out-of-hours-reply.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { WatchdogConfigService } from './watchdog-config.service';
import { WatchdogCronService } from './watchdog-cron.service';
import {
  WATCHDOG_QUEUE,
  WATCHDOG_CHECK_JOB,
  WATCHDOG_FALLBACK_JOB,
  WatchdogJobData,
} from './watchdog.types';

/**
 * Decide o que fazer quando um timer do watchdog vence. Lê o estado atual
 * da conversa (não o que estava no momento do agendamento) e roteia:
 *
 *  - status=BOT      → reativa IA (provavelmente travou no meio)
 *  - status=PENDING  → IA assume (ninguém pegou)
 *  - status=OPEN     → IA reassume se humano há tempo sem responder
 *  - status=WAITING  → no-op (esperando cliente é estado natural)
 *  - status=CLOSED   → no-op (job velho, conversa já encerrou)
 *
 * Sempre que tenta reativar a IA, incrementa `stuckAttempts`. Quando
 * passa de `maxAttempts`, marca `isStuck=true` e notifica os gestores
 * em vez de tentar de novo — evita loop infinito quando a IA está com
 * bug determinístico.
 */
@Processor(WATCHDOG_QUEUE, { concurrency: 4 })
export class WatchdogTimerProcessor extends WorkerHost {
  private readonly logger = new Logger(WatchdogTimerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: WatchdogConfigService,
    private readonly notifications: NotificationsService,
    private readonly agentRunner: AiAgentRunnerService,
    private readonly agentRouter: AgentRouterService,
    private readonly outOfHoursReply: OutOfHoursReplyService,
    private readonly realtime: RealtimeGateway,
    @Inject(forwardRef(() => WatchdogCronService))
    private readonly cron: WatchdogCronService,
  ) {
    super();
  }

  async process(job: Job<WatchdogJobData>): Promise<unknown> {
    // O cron de fallback usa a mesma fila — diferencia pelo nome do job.
    if (job.name === WATCHDOG_FALLBACK_JOB) {
      return this.cron.scanAndEnqueue();
    }
    if (job.name !== WATCHDOG_CHECK_JOB) {
      return { skipped: true, reason: 'unknown_job_name' };
    }
    const { conversationId, scheduledAtAttempts } = job.data;

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: {
        organization: true,
        contact: { select: { name: true, phone: true } },
        assignedTo: { select: { id: true, name: true } },
      },
    });

    if (!conversation) {
      return { skipped: true, reason: 'conversation_not_found' };
    }
    if (conversation.deletedAt) {
      return { skipped: true, reason: 'conversation_deleted' };
    }
    if (!conversation.organization.watchdogEnabled) {
      await this.clearJobId(conversationId);
      return { skipped: true, reason: 'watchdog_disabled' };
    }
    if (!this.config.isWithinBusinessHours(conversation.organization)) {
      // Reagenda pra quando voltar ao horário? Não — mantém simples e deixa
      // a próxima inbound ou o cron de fallback re-agendar. Watchdog fora
      // de horário só não atua, não acumula divida. Ainda assim avisa o
      // cliente (dedupe interno evita repetir se já avisou antes).
      await this.outOfHoursReply
        .maybeReply(conversation)
        .catch((err) =>
          this.logger.warn(
            `Out-of-hours reply failed for conv ${conversationId}: ${err?.message ?? err}`,
          ),
        );
      await this.clearJobId(conversationId);
      return { skipped: true, reason: 'outside_business_hours' };
    }

    // Conversa já em estado terminal — nada a fazer.
    if (
      conversation.status === ConversationStatus.WAITING ||
      conversation.status === ConversationStatus.CLOSED
    ) {
      await this.clearJobId(conversationId);
      return { skipped: true, reason: `status_${conversation.status}` };
    }

    if (conversation.aiEnabled === false) {
      // Humano desativou IA — não reativa, mas sinaliza pro humano.
      await this.notifyAssignee(
        conversation.organizationId,
        conversation.assignedTo?.id,
        conversation.id,
        conversation.contact?.name ?? conversation.contact?.phone ?? 'Cliente',
        'ai_disabled_by_human',
      );
      await this.clearJobId(conversationId);
      return { skipped: true, reason: 'ai_disabled_by_human' };
    }

    // Última msg precisa ser do cliente (INBOUND) — se foi nossa, então
    // já respondemos e tá tudo bem, esse job é stale.
    const lastMessage = await this.prisma.message.findFirst({
      where: { conversationId },
      orderBy: { createdAt: 'desc' },
      select: { direction: true, createdAt: true },
    });
    if (
      !lastMessage ||
      lastMessage.direction !== MessageDirection.INBOUND
    ) {
      await this.clearJobId(conversationId);
      return { skipped: true, reason: 'last_message_outbound' };
    }

    // Race protection: se outro fluxo (msg humana, agent run, novo timer)
    // já avançou stuckAttempts além do que esse job foi agendado pra
    // tratar, descarta — outro path já respondeu por essa janela.
    if (conversation.stuckAttempts > scheduledAtAttempts) {
      await this.clearJobId(conversationId);
      return { skipped: true, reason: 'attempts_advanced' };
    }

    const cfg = this.config.resolve(conversation.organization);
    const nextAttempts = conversation.stuckAttempts + 1;

    // Limite atingido → não tenta de novo. Marca como presa, escala pra
    // humano e notifica gestores. Opera como "última cartada": ao virar
    // PENDING + isStuck a conversa aparece no filtro "presas" do dashboard.
    if (nextAttempts > cfg.maxAttempts) {
      await this.markStuck(
        conversationId,
        conversation.organizationId,
        conversation.contact?.name ?? conversation.contact?.phone ?? 'Cliente',
      );
      await this.clearJobId(conversationId);
      return { stuck: true, attempts: conversation.stuckAttempts };
    }

    // Atualiza contador antes de agir — se o agent run der erro, a próxima
    // execução do watchdog vê stuckAttempts já incrementado e progride o
    // limite mesmo assim (caso contrário ficaria em loop pra sempre).
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        stuckAttempts: nextAttempts,
        lastWatchdogCheckAt: new Date(),
        watchdogJobId: null,
      },
    });

    // Em status=OPEN com humano atribuído, primeiro notifica o humano —
    // só reativa IA se ele tá fora há tempo (já passou delayHumanIdleMin
    // que é o delay desse job). Aqui sempre reativa porque o delay já
    // foi respeitado no agendamento.
    if (
      conversation.status === ConversationStatus.OPEN &&
      conversation.assignedTo?.id
    ) {
      await this.notifyAssignee(
        conversation.organizationId,
        conversation.assignedTo.id,
        conversation.id,
        conversation.contact?.name ?? conversation.contact?.phone ?? 'Cliente',
        'human_idle_taking_over',
      );
    }

    // Reativa IA. Antes checa se o roteador deixa rodar — pode ter
    // mudado config no meio do caminho (token cap, kill switch, etc).
    const fresh = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
    });
    if (!fresh) return { skipped: true, reason: 'conversation_vanished' };

    const decision = await this.agentRouter.shouldHandle(fresh);
    if (!decision.handle) {
      this.logger.warn(
        `Watchdog wanted to rerun AI but router blocked: conv=${conversationId} reason=${decision.reason}`,
      );
      // O router usa `org.aiBusinessHours` (pode divergir do
      // `watchdogBusinessHours` checado acima) — se foi esse o motivo,
      // ainda vale mandar o aviso de fora de horário (dedupe interno
      // evita repetir se o inbound original já mandou).
      if (decision.reason === 'outside-business-hours') {
        await this.outOfHoursReply
          .maybeReply(fresh)
          .catch((err) =>
            this.logger.warn(
              `Out-of-hours reply failed for conv ${conversationId}: ${err?.message ?? err}`,
            ),
          );
      }
      return { skipped: true, reason: `router_${decision.reason}` };
    }

    // Pega a última mensagem INBOUND (a que está sem resposta) como
    // trigger pra o run.
    const triggerMessage = await this.prisma.message.findFirst({
      where: { conversationId, direction: MessageDirection.INBOUND },
      orderBy: { createdAt: 'desc' },
    });
    if (!triggerMessage) {
      return { skipped: true, reason: 'no_inbound_trigger' };
    }

    try {
      // Se status=PENDING, promove pra BOT antes do run — assim a UI
      // mostra a IA atendendo e não fica "ninguém pegou".
      if (conversation.status === ConversationStatus.PENDING) {
        await this.prisma.conversation.update({
          where: { id: conversationId },
          data: { status: ConversationStatus.BOT },
        });
      }

      await this.agentRunner.run({ conversation: fresh, triggerMessage });

      this.logger.log(
        `Watchdog reactivated AI: conv=${conversationId} attempts=${nextAttempts}/${cfg.maxAttempts}`,
      );
      return { reactivated: true, attempts: nextAttempts };
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Watchdog AI reactivation failed: conv=${conversationId} attempts=${nextAttempts}: ${msg}`,
      );
      // Não relança — o BullMQ não deve retentar esse job. A próxima
      // mensagem do cliente OU o cron de fallback vão tentar de novo.
      return { reactivated: false, error: msg, attempts: nextAttempts };
    }
  }

  private async markStuck(
    conversationId: string,
    organizationId: string,
    contactName: string,
  ): Promise<void> {
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: {
        isStuck: true,
        status: ConversationStatus.PENDING,
        watchdogJobId: null,
      },
    });

    await this.notifications.notifyOrgAgents({
      organizationId,
      type: NotificationType.SLA_BREACH,
      title: 'Conversa presa',
      body: `A conversa com ${contactName} foi marcada como presa após várias tentativas sem resposta. Precisa de atendimento humano.`,
      data: { conversationId, watchdog: true },
    });

    this.realtime.emitToOrg(organizationId, 'conversation:stuck', {
      conversationId,
    });

    this.logger.warn(`Conversation marked STUCK: conv=${conversationId}`);
  }

  private async notifyAssignee(
    organizationId: string,
    assigneeId: string | undefined,
    conversationId: string,
    contactName: string,
    reason: string,
  ): Promise<void> {
    if (!assigneeId) return;
    await this.notifications
      .notify({
        recipientId: assigneeId,
        organizationId,
        type: NotificationType.SLA_WARNING,
        title: 'Conversa sem resposta há um tempo',
        body: `${contactName} está esperando resposta. Cuide ou deixe a IA assumir.`,
        data: { conversationId, watchdog: true, reason },
      })
      .catch((err) =>
        this.logger.warn(
          `Failed to notify assignee ${assigneeId}: ${err.message ?? err}`,
        ),
      );
  }

  private async clearJobId(conversationId: string): Promise<void> {
    await this.prisma.conversation
      .update({
        where: { id: conversationId },
        data: { watchdogJobId: null },
      })
      .catch(() => undefined);
  }
}
