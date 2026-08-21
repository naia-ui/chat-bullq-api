import { Logger } from '@nestjs/common';
import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Prisma } from '@prisma/client';
import type { Job } from 'bullmq';

import { PrismaService } from '../../../database/prisma.service';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import type { ToolContext } from '../tools/tool.types';
import { PendingActionStorage } from './pending-action.storage';
import { HandoffExecutionService } from '../handoff/handoff-execution.service';
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
 *   - resolve a tool original (skill HTTP que ainda usa o gate manual)
 *   - executa de fato (HTTP com `bypassPendingGate: true` pra evitar loop)
 *   - grava `executionResult` e marca status `EXECUTED`
 *
 * `transferToHuman` deixou de passar por aqui em 17/08/2026 — a tool
 * executa o handoff direto (HandoffExecutionService), sem esperar
 * aprovação manual (24/7 sem alguém sempre de olho no painel). O branch
 * `transferToHuman` abaixo fica só como caminho legado, se algum dia
 * existir um PendingAction desse tipo criado por outra via.
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
    private readonly handoffExecution: HandoffExecutionService,
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

  /**
   * Legado: só é acionado se algum dia existir um PendingAction
   * toolName=transferToHuman pendente de verdade (ex.: criado manualmente
   * via API). Desde 17/08/2026 a `TransferToHumanTool` executa o handoff
   * direto, sem passar por aqui — ver `HandoffExecutionService`.
   */
  private async executeTransferToHuman(action: {
    conversationId: string;
    agentId: string;
    args: Record<string, unknown>;
  }): Promise<unknown> {
    const reason =
      typeof action.args?.reason === 'string' ? action.args.reason : null;
    return this.handoffExecution.execute({
      conversationId: action.conversationId,
      agentId: action.agentId,
      reason,
    });
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
