import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ConversationStatus, NotificationType } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';

@Processor('sla-timers', { concurrency: 2 })
export class SlaTimerProcessor extends WorkerHost {
  private readonly logger = new Logger(SlaTimerProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
  ) {
    super();
  }

  async process(job: Job): Promise<any> {
    const { conversationId, type, organizationId } = job.data as {
      conversationId: string;
      type: 'first-response' | 'resolution';
      organizationId: string;
    };

    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: { select: { name: true, phone: true } }, assignedTo: { select: { id: true, name: true } } },
    });

    if (!conversation) return { skipped: true, reason: 'conversation_not_found' };

    if (type === 'first-response') {
      if (conversation.firstResponseAt || conversation.status === ConversationStatus.CLOSED) {
        return { skipped: true, reason: 'already_responded_or_closed' };
      }

      const contactName = conversation.contact?.name || conversation.contact?.phone || 'Cliente';

      await this.notifications.notifyOrgAgents({
        organizationId,
        type: NotificationType.SLA_BREACH,
        title: 'SLA de primeira resposta violado',
        body: `A conversa com ${contactName} ultrapassou o tempo de SLA sem resposta.`,
        data: { conversationId, slaType: 'first-response' },
      });

      this.logger.warn(`SLA first-response BREACH: conversation=${conversationId}`);
      return { breach: true, type: 'first-response' };
    }

    if (type === 'resolution') {
      if (conversation.status === ConversationStatus.CLOSED) {
        return { skipped: true, reason: 'already_closed' };
      }

      const contactName = conversation.contact?.name || conversation.contact?.phone || 'Cliente';

      await this.notifications.notifyOrgAgents({
        organizationId,
        excludeUserId: conversation.assignedTo?.id,
        type: NotificationType.SLA_WARNING,
        title: 'SLA de resolução em risco',
        body: `A conversa com ${contactName} está se aproximando do limite de SLA.`,
        data: { conversationId, slaType: 'resolution' },
      });

      if (conversation.assignedTo) {
        await this.notifications.notify({
          recipientId: conversation.assignedTo.id,
          organizationId,
          type: NotificationType.SLA_BREACH,
          title: 'SLA de resolução violado',
          body: `Sua conversa com ${contactName} ultrapassou o SLA de resolução.`,
          data: { conversationId, slaType: 'resolution' },
        });
      }

      this.logger.warn(`SLA resolution BREACH: conversation=${conversationId}`);
      return { breach: true, type: 'resolution' };
    }

    return { skipped: true, reason: 'unknown_type' };
  }
}
