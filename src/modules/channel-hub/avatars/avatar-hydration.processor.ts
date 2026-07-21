import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ChannelType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ZappfyContactEnricherService } from '../adapters/zappfy/zappfy-contact-enricher.service';
import {
  AVATAR_HYDRATION_QUEUE,
  type AvatarHydrationJob,
} from './avatar-hydration.constants';

/**
 * Busca a foto de perfil de um contato/grupo fora do caminho da requisição.
 *
 * `concurrency: 1` é de propósito: o espaçamento entre as fotos é o que
 * mantém o provider feliz, e nada disso é urgente — foto é enfeite, então
 * qualquer falha aqui só significa que a UI segue com as iniciais.
 */
@Processor(AVATAR_HYDRATION_QUEUE, { concurrency: 1 })
export class AvatarHydrationProcessor extends WorkerHost {
  private readonly logger = new Logger(AvatarHydrationProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enricher: ZappfyContactEnricherService,
  ) {
    super();
  }

  async process(job: Job<AvatarHydrationJob>): Promise<void> {
    const { channelId, externalContactId, force, maxAgeDays } = job.data;

    const channel = await this.prisma.channel.findFirst({
      where: { id: channelId, deletedAt: null },
    });
    if (!channel || channel.type !== ChannelType.WHATSAPP_ZAPPFY) return;

    await this.enricher.enrich(channel, externalContactId, { force, maxAgeDays });
  }

  async onFailed(job: Job<AvatarHydrationJob>, err: Error): Promise<void> {
    this.logger.debug(
      `Hidratação de avatar falhou (${job?.data?.externalContactId}): ${err.message}`,
    );
  }
}
