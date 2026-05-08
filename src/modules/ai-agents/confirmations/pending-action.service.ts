import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import type {
  CreatePendingActionInput,
  PendingAction,
  PendingActionStatus,
} from './confirmation.types';
import { PendingActionStorage } from './pending-action.storage';
import { PENDING_ACTION_EXECUTOR_QUEUE } from './pending-action-executor.processor';

/**
 * Service that owns the lifecycle of `PendingAction` records.
 *
 * Phase 1: pure CRUD + approve/reject + expiration check.
 * Phase 2: on `approve()` enqueue the actual tool execution (the args
 * are stored verbatim on the record).
 */
@Injectable()
export class PendingActionService {
  private readonly logger = new Logger(PendingActionService.name);
  private readonly DEFAULT_TTL_MIN = 30;

  constructor(
    private readonly storage: PendingActionStorage,
    @InjectQueue(PENDING_ACTION_EXECUTOR_QUEUE)
    private readonly executorQueue: Queue,
  ) {}

  /** Create a new PENDING action for human review. */
  async create(input: CreatePendingActionInput): Promise<PendingAction> {
    const now = new Date();
    const ttlMin = input.ttlMinutes ?? this.DEFAULT_TTL_MIN;
    const expiresAt = new Date(now.getTime() + ttlMin * 60 * 1000);

    const action: PendingAction = {
      id: randomUUID(),
      agentRunId: input.agentRunId,
      conversationId: input.conversationId,
      agentId: input.agentId,
      toolName: input.toolName,
      args: input.args,
      preview: input.preview,
      status: 'PENDING',
      createdAt: now.toISOString(),
      expiresAt: expiresAt.toISOString(),
    };

    await this.storage.save(action);

    this.logger.log({
      msg: 'pending_action_created',
      id: action.id,
      toolName: action.toolName,
      impact: action.preview.impact,
      conversationId: action.conversationId,
      expiresAt: action.expiresAt,
    });

    return action;
  }

  /**
   * Approve a pending action. If it has already expired in storage,
   * the status is moved to EXPIRED and the call fails.
   *
   * Phase 2 TODO: enqueue the actual execution of `action.toolName`
   * with `action.args` and persist `executionResult` once it runs.
   */
  async approve(id: string, userId: string): Promise<PendingAction> {
    const action = await this.storage.get(id);
    if (!action) throw new NotFoundException('Pending action not found');

    if (action.status !== 'PENDING') {
      throw new BadRequestException(
        `Action is ${action.status} and cannot be approved`,
      );
    }

    if (this.isExpired(action)) {
      const previous = action.status;
      action.status = 'EXPIRED';
      await this.storage.save(action, previous);
      throw new BadRequestException('Action expired');
    }

    const previous = action.status;
    action.status = 'APPROVED';
    action.approvedBy = userId;
    action.approvedAt = new Date().toISOString();
    await this.storage.save(action, previous);

    this.logger.log({
      msg: 'pending_action_approved',
      id,
      userId,
      toolName: action.toolName,
    });

    // Fase 2.5: enfileira execução real da tool. O processor
    // (PendingActionExecutorProcessor) resolve built-in vs HTTP skill,
    // executa com bypassPendingGate, salva executionResult e marca EXECUTED.
    try {
      await this.executorQueue.add(
        'execute_pending',
        { pendingActionId: id },
        { removeOnComplete: 100, removeOnFail: 50 },
      );
    } catch (err: any) {
      this.logger.error(
        `Failed to enqueue executor for pending action ${id}: ${err?.message ?? err}`,
      );
      // Não rethrow — aprovação foi salva. Operador pode re-disparar via UI.
    }

    return action;
  }

  /**
   * Reject a pending action with a human-readable reason.
   */
  async reject(
    id: string,
    userId: string,
    reason: string,
  ): Promise<PendingAction> {
    if (!reason || !reason.trim()) {
      throw new BadRequestException('Rejection reason is required');
    }

    const action = await this.storage.get(id);
    if (!action) throw new NotFoundException('Pending action not found');

    if (action.status !== 'PENDING') {
      throw new BadRequestException(
        `Action is ${action.status} and cannot be rejected`,
      );
    }

    if (this.isExpired(action)) {
      const previous = action.status;
      action.status = 'EXPIRED';
      await this.storage.save(action, previous);
      throw new BadRequestException('Action expired');
    }

    const previous = action.status;
    action.status = 'REJECTED';
    action.rejectedBy = userId;
    action.rejectedAt = new Date().toISOString();
    action.rejectedReason = reason.trim();
    await this.storage.save(action, previous);

    this.logger.log({
      msg: 'pending_action_rejected',
      id,
      userId,
      toolName: action.toolName,
    });

    return action;
  }

  /** List PENDING actions, optionally filtered by conversation. */
  async listPending(conversationId?: string): Promise<PendingAction[]> {
    return this.storage.listByStatus('PENDING', conversationId);
  }

  /** List actions for a given status. */
  async listByStatus(
    status: PendingActionStatus,
    conversationId?: string,
  ): Promise<PendingAction[]> {
    return this.storage.listByStatus(status, conversationId);
  }

  /** List every action (any status) for a conversation. */
  async listForConversation(conversationId: string): Promise<PendingAction[]> {
    return this.storage.listByConversation(conversationId);
  }

  async get(id: string): Promise<PendingAction | null> {
    return this.storage.get(id);
  }

  /**
   * Check & sweep expirations.
   *
   * Walks every PENDING action, marks expired ones as EXPIRED, returns
   * the count moved. Cron-friendly (idempotent). Phase 2 will wire this
   * to a `@Cron('* * * * *')` runner.
   */
  async expireOverdue(): Promise<number> {
    const pending = await this.storage.listByStatus('PENDING');
    let moved = 0;
    for (const action of pending) {
      if (this.isExpired(action)) {
        const previous = action.status;
        action.status = 'EXPIRED';
        await this.storage.save(action, previous);
        moved++;
        this.logger.log({
          msg: 'pending_action_expired',
          id: action.id,
          toolName: action.toolName,
        });
      }
    }
    return moved;
  }

  private isExpired(action: PendingAction): boolean {
    return new Date(action.expiresAt).getTime() < Date.now();
  }
}
