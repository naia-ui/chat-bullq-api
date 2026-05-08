import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';

import {
  PENDING_ACTION_EXECUTOR_QUEUE,
  PENDING_EXPIRE_JOB,
} from './pending-action-executor.processor';

const REPEAT_PATTERN = '*/5 * * * *'; // a cada 5min
const REPEAT_JOB_ID = 'pending-action-expire-cron';

/**
 * Fase 2.5: registra um repeatable job na queue do executor que dispara
 * `expireOverdueActions()` a cada 5min. Usa BullMQ repeatable em vez de
 * @nestjs/schedule pra evitar dependência nova e manter consistência com
 * o resto do projeto (memory-extractor, rag-indexer).
 *
 * Idempotente: BullMQ não duplica jobId — múltiplas instâncias da app
 * registram a mesma chave e o Bull só mantém uma.
 */
@Injectable()
export class PendingActionCronService implements OnModuleInit {
  private readonly logger = new Logger(PendingActionCronService.name);

  constructor(
    @InjectQueue(PENDING_ACTION_EXECUTOR_QUEUE)
    private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        PENDING_EXPIRE_JOB,
        {},
        {
          repeat: { pattern: REPEAT_PATTERN },
          jobId: REPEAT_JOB_ID,
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log({
        msg: 'pending_action_cron_registered',
        pattern: REPEAT_PATTERN,
      });
    } catch (err: any) {
      this.logger.error(
        `Failed to register pending-action expiration cron: ${err?.message ?? err}`,
      );
    }
  }
}
