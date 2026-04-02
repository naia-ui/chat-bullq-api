import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class SlaService {
  private readonly logger = new Logger(SlaService.name);

  constructor(
    private readonly prisma: PrismaService,
    @InjectQueue('sla-timers') private readonly slaQueue: Queue,
  ) {}

  async scheduleFirstResponseTimer(conversationId: string, organizationId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { department: true },
    });

    const slaMinutes = conversation?.department?.slaFirstResponse;
    if (!slaMinutes) return;

    await this.slaQueue.add(
      'sla-check',
      { conversationId, type: 'first-response', organizationId },
      { delay: slaMinutes * 60 * 1000, jobId: `sla-fr-${conversationId}` },
    );

    this.logger.log(`SLA first-response timer set: ${slaMinutes}min for conv=${conversationId}`);
  }

  async scheduleResolutionTimer(conversationId: string, organizationId: string): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { department: true },
    });

    const slaMinutes = conversation?.department?.slaResolution;
    if (!slaMinutes) return;

    await this.slaQueue.add(
      'sla-check',
      { conversationId, type: 'resolution', organizationId },
      { delay: slaMinutes * 60 * 1000, jobId: `sla-res-${conversationId}` },
    );

    this.logger.log(`SLA resolution timer set: ${slaMinutes}min for conv=${conversationId}`);
  }

  async cancelTimers(conversationId: string): Promise<void> {
    try {
      const frJob = await this.slaQueue.getJob(`sla-fr-${conversationId}`);
      if (frJob) await frJob.remove();
      const resJob = await this.slaQueue.getJob(`sla-res-${conversationId}`);
      if (resJob) await resJob.remove();
    } catch {
      // Job may not exist
    }
  }
}
