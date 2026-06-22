import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { SalesRecoveryService } from './sales-recovery.service';
import { RECOVERY_OUTREACH_QUEUE } from './sales-recovery.constants';

interface OutreachJobData {
  cardId: string;
}

/**
 * Dispara o opener depois do delay agendado (ex.: 10min pós PIX). A decisão
 * de enviar ou não (lead já pagou? cooldown de 24h?) fica no service —
 * aqui só chamamos no horário certo.
 */
@Processor(RECOVERY_OUTREACH_QUEUE, { concurrency: 3 })
export class RecoveryOutreachProcessor extends WorkerHost {
  private readonly logger = new Logger(RecoveryOutreachProcessor.name);

  constructor(private readonly recovery: SalesRecoveryService) {
    super();
  }

  async process(job: Job<OutreachJobData>): Promise<void> {
    const { cardId } = job.data;
    if (!cardId) return;
    await this.recovery.dispatchOutreach(cardId);
  }
}
