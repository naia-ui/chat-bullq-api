import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../../database/prisma.service';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import type { ToolContext } from '../tools/tool.types';
import { PendingActionStorage } from './pending-action.storage';
import {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXPIRE_JOB,
} from './queue-names';

export {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXECUTE_JOB,
  PENDING_EXPIRE_JOB,
} from './queue-names';

type ExecutorJobData =
  | { pendingActionId: string }
  | Record<string, never>;

/**
 * Fase 2.5: executor pós-aprovação.
 *
 * Quando o operador aprova um `AiPendingAction`, o `PendingActionService`
 * enfileira aqui. Esse worker:
 *   - resolve a tool original (built-in `transferToHuman` ou skill HTTP)
 *   - executa de fato (HTTP com `bypassPendingGate: true` pra evitar loop)
 *   - grava `executionResult` e marca status `EXECUTED`
 *
 * Falhas resultam em status PENDING + executionResult com error → operador
 * pode re-aprovar. Não bloqueia outras pendings.
 */
@Processor(PENDING_ACTION_EXECUTOR_QUEUE, { concurrency: 4 })
export class PendingActionExecutorProcessor extends WorkerHost {
  private readonly logger = new Logger(PendingActionExecutorProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpExecutor: HttpToolExecutorService,
    private readonly storage: PendingActionStorage,
  ) {
    super();
  }

  async process(job: Job<ExecutorJobData>): Promise<unknown> {
    if (job.name === PENDING_EXPIRE_JOB) {
      return this.expireOverdueActions();
    }
    const { pendingActionId } = job.data as { pendingActionId: string };
    const action = await this.storage.get(pendingActionId);

    if (!action) {
      this.logger.warn(`Pending action ${pendingActionId} not found`);
      return { skipped: true, reason: 'not_found' };
    }
    if (action.status !== 'APPROVED') {
      this.logger.warn(
        `Pending action ${pendingActionId} status=${action.status} (skipping execution)`,
      );
      return { skipped: true, reason: `status_${action.status}` };
    }

    let result: unknown;
    let success = true;

    try {
      if (action.toolName === 'transferToHuman') {
        result = await this.executeTransferToHuman(action);
      } else {
        result = await this.executeHttpSkill(action);
      }
    } catch (err: any) {
      success = false;
      result = { ok: false, error: err?.message ?? String(err) };
      this.logger.error(
        `Pending action ${pendingActionId} (${action.toolName}) failed: ${err?.message ?? err}`,
      );
    }

    await this.prisma.aiPendingAction.update({
      where: { id: pendingActionId },
      data: {
        status: success ? 'EXECUTED' : 'APPROVED', // re-tentável se falhou
        executionResult: (result as Prisma.InputJsonValue) ?? Prisma.JsonNull,
      },
    });

    this.logger.log({
      msg: 'pending_action_executed',
      pendingActionId,
      toolName: action.toolName,
      success,
    });

    return result;
  }

  /**
   * Cron-style cleanup: marca como EXPIRED qualquer PendingAction que
   * passou do `expiresAt` sem ser aprovado/rejeitado. Disparado por
   * repeatable job (a cada 5min) registrado em `confirmations.module`.
   */
  private async expireOverdueActions(): Promise<{ expired: number }> {
    const result = await this.prisma.aiPendingAction.updateMany({
      where: {
        status: 'PENDING',
        expiresAt: { lt: new Date() },
      },
      data: { status: 'EXPIRED' },
    });
    if (result.count > 0) {
      this.logger.log({
        msg: 'pending_actions_expired',
        count: result.count,
      });
    }
    return { expired: result.count };
  }

  private async executeTransferToHuman(action: {
    conversationId: string;
    args: Record<string, unknown>;
  }): Promise<unknown> {
    // Pausa a IA na conversa + sinaliza que aguarda atendente humano.
    // Notificações em tempo real (banner no inbox) já foram emitidas no
    // momento da criação do PendingAction — aqui só efetivamos a transição.
    await this.prisma.conversation.update({
      where: { id: action.conversationId },
      data: { aiEnabled: false },
    });

    await this.upsertHandoffCard(action.conversationId, action.args);

    return {
      ok: true,
      transferredAt: new Date().toISOString(),
      reason: action.args?.reason ?? null,
    };
  }

  /**
   * Best-effort: joga a conversa no card do pipeline padrão da org, na
   * etapa "Aguardando advogada" — cria se não existir card OPEN pro
   * contato nesse pipeline, ou só move se já existir (evita duplicar card
   * a cada novo handoff da mesma conversa). Nunca deve derrubar o handoff
   * em si — qualquer erro aqui só é logado.
   */
  private async upsertHandoffCard(
    conversationId: string,
    args: Record<string, unknown>,
  ): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { organizationId: true, contactId: true },
      });
      if (!conversation) return;

      const pipeline = await this.prisma.pipeline.findFirst({
        where: {
          organizationId: conversation.organizationId,
          isDefault: true,
          archived: false,
        },
        include: { stages: true },
      });
      if (!pipeline) return;

      const stage =
        pipeline.stages.find((s) => s.name === 'Aguardando advogada') ??
        pipeline.stages.find((s) => s.type === 'NORMAL');
      if (!stage) return;

      const existing = await this.prisma.card.findFirst({
        where: {
          organizationId: conversation.organizationId,
          pipelineId: pipeline.id,
          contactId: conversation.contactId,
          status: 'OPEN',
        },
      });

      if (existing) {
        await this.prisma.card.update({
          where: { id: existing.id },
          data: { stageId: stage.id, conversationId },
        });
        return;
      }

      const contact = await this.prisma.contact.findUnique({
        where: { id: conversation.contactId },
        select: { name: true, phone: true },
      });
      const title = contact?.name || contact?.phone || 'Novo contato';
      const reason = typeof args?.reason === 'string' ? args.reason : null;

      await this.prisma.card.create({
        data: {
          organizationId: conversation.organizationId,
          pipelineId: pipeline.id,
          stageId: stage.id,
          title,
          description: reason,
          contactId: conversation.contactId,
          conversationId,
          status: 'OPEN',
          metadata: { createdBy: 'transferToHuman' },
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to create/move handoff pipeline card for conversation ${conversationId}: ${err?.message ?? err}`,
      );
    }
  }

  private async executeHttpSkill(action: {
    agentRunId: string;
    conversationId: string;
    agentId: string;
    toolName: string;
    args: Record<string, unknown>;
  }): Promise<unknown> {
    const skill = await this.prisma.aiSkill.findFirst({
      where: { name: action.toolName, isActive: true, deletedAt: null },
    });
    if (!skill) {
      throw new Error(`Skill ${action.toolName} not found or inactive`);
    }
    if (!skill.toolId) {
      throw new Error(`Skill ${action.toolName} has no bound tool`);
    }
    const tool = await this.prisma.aiTool.findUnique({
      where: { id: skill.toolId },
    });
    if (!tool) {
      throw new Error(`Tool ${skill.toolId} not found for skill ${skill.name}`);
    }

    const run = await this.prisma.aiAgentRun.findUnique({
      where: { id: action.agentRunId },
      select: { organizationId: true, triggerMessageId: true },
    });
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: action.conversationId },
      select: { contactId: true, channelId: true },
    });
    if (!run || !conversation) {
      throw new Error('Run or conversation no longer exists');
    }

    const ctx: ToolContext = {
      organizationId: run.organizationId,
      conversationId: action.conversationId,
      contactId: conversation.contactId,
      channelId: conversation.channelId,
      agentId: action.agentId,
      runId: action.agentRunId,
      triggerMessageId: run.triggerMessageId ?? '',
    };

    const result = await this.httpExecutor.execute(
      skill,
      tool,
      action.args,
      ctx,
      { bypassPendingGate: true },
    );
    return result.output;
  }
}
