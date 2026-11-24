import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Queue } from 'bullmq';
import {
  CONVERSIONS_JOB,
  CONVERSIONS_QUEUE,
  DISPATCH_PATTERN_DEFAULT,
} from './conversions.constants';
import { ConversionsService } from './conversions.service';

/**
 * Despachante da fila de conversões: a cada 15 minutos (padrão) processa o
 * que venceu a carência. Mesmo desenho do cron de saúde do Zappfy — job
 * repetível do BullMQ, concorrência 1, para duas réplicas da API não
 * enviarem a mesma conversão.
 *
 * Com as chaves desligadas o ciclo continua rodando: ele grava a
 * pré-visualização de cada linha e não chama nenhuma plataforma. É assim
 * que se confere o que sairia antes de ligar.
 */
@Processor(CONVERSIONS_QUEUE, { concurrency: 1 })
export class ConversionsDispatchCron
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ConversionsDispatchCron.name);

  constructor(
    private readonly conversions: ConversionsService,
    private readonly config: ConfigService,
    @InjectQueue(CONVERSIONS_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const pattern =
      this.config.get<string>('CONVERSIONS_DISPATCH_PATTERN') ||
      DISPATCH_PATTERN_DEFAULT;
    try {
      await this.queue.add(
        CONVERSIONS_JOB,
        {},
        {
          repeat: { pattern },
          jobId: 'conversions-dispatch-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`conversions_dispatch_cron_registered pattern=${pattern}`);
    } catch (err) {
      this.logger.error(
        `Falha registrando o despachante de conversões: ${(err as Error).message}`,
      );
    }
  }

  async process(): Promise<void> {
    await this.conversions.dispatchDue();
  }
}
