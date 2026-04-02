import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { IdempotencyService } from './idempotency.service';
import { ContactResolverService } from './contact-resolver.service';
import { ConversationResolverService } from './conversation-resolver.service';
import { RealtimeGateway } from '../../realtime/realtime.gateway';
import { NormalizedInboundMessage } from '../../channel-hub/ports/types';
import { MessageDirection, MessageContentType as PrismaContentType, MessageStatus, ConversationStatus } from '@prisma/client';

interface InboundJobData {
  channelId: string;
  organizationId: string;
  message: NormalizedInboundMessage;
}

@Processor('inbound-messages', { concurrency: 10 })
export class InboundMessageProcessor extends WorkerHost {
  private readonly logger = new Logger(InboundMessageProcessor.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly idempotency: IdempotencyService,
    private readonly contactResolver: ContactResolverService,
    private readonly conversationResolver: ConversationResolverService,
    private readonly realtimeGateway: RealtimeGateway,
    @InjectQueue('chatbot-processor') private readonly chatbotQueue: Queue,
  ) {
    super();
  }

  async process(job: Job<InboundJobData>): Promise<any> {
    const { channelId, organizationId, message } = job.data;

    if (job.name === 'process-status') {
      return this.processStatus(job.data as any);
    }

    const isDuplicate = await this.idempotency.isDuplicate(
      message.externalMessageId,
      channelId,
    );
    if (isDuplicate) {
      this.logger.debug(`Duplicate message skipped: ${message.externalMessageId}`);
      return { skipped: true, reason: 'duplicate' };
    }

    const { contactId } = await this.contactResolver.resolve(
      organizationId,
      channelId,
      message,
    );

    const { conversationId, status } = await this.conversationResolver.resolve(
      organizationId,
      channelId,
      contactId,
    );

    const savedMessage = await this.prisma.message.create({
      data: {
        conversationId,
        direction: MessageDirection.INBOUND,
        type: message.type as unknown as PrismaContentType,
        content: message.content as any,
        externalId: message.externalMessageId,
        status: MessageStatus.DELIVERED,
        deliveredAt: new Date(),
        metadata: { rawPayload: JSON.parse(JSON.stringify(message.rawPayload ?? null)) },
      },
    });

    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { lastMessageAt: new Date() },
    });

    await this.idempotency.markProcessed(message.externalMessageId, channelId);

    this.realtimeGateway.emitToOrg(organizationId, 'message:new', {
      message: savedMessage,
      conversationId,
      contactId,
    });
    this.realtimeGateway.emitToConversation(conversationId, 'message:new', {
      message: savedMessage,
    });

    if (status === ConversationStatus.BOT || status === ConversationStatus.PENDING) {
      const hasActiveBot = await this.checkActiveBotForChannel(channelId);
      if (hasActiveBot) {
        if (status === ConversationStatus.PENDING) {
          await this.prisma.conversation.update({
            where: { id: conversationId },
            data: { status: ConversationStatus.BOT },
          });
        }
        await this.chatbotQueue.add('process-bot', {
          conversationId,
          channelId,
          contactExternalId: message.externalContactId,
          organizationId,
          messageText: (message.content as any)?.text || '',
        });
        this.logger.log(`Routed to chatbot: conv=${conversationId}`);
      }
    }

    this.logger.log(
      `Inbound processed: msg=${savedMessage.id} conv=${conversationId} contact=${contactId} type=${message.type}`,
    );

    return {
      messageId: savedMessage.id,
      conversationId,
      contactId,
      conversationStatus: status,
    };
  }

  private async checkActiveBotForChannel(channelId: string): Promise<boolean> {
    const link = await this.prisma.chatbotFlowChannel.findFirst({
      where: {
        channelId,
        flow: { isActive: true, deletedAt: null },
      },
    });
    return !!link;
  }

  private async processStatus(data: any): Promise<any> {
    const { status } = data;
    if (!status?.externalMessageId) return;

    const statusMap: Record<string, MessageStatus> = {
      sent: MessageStatus.SENT,
      delivered: MessageStatus.DELIVERED,
      read: MessageStatus.READ,
      failed: MessageStatus.FAILED,
    };

    const dbStatus = statusMap[status.status];
    if (!dbStatus) return;

    const message = await this.prisma.message.findFirst({
      where: { externalId: status.externalMessageId },
    });

    if (!message) return;

    const updateData: Record<string, any> = { status: dbStatus };
    if (dbStatus === MessageStatus.SENT) updateData.sentAt = status.timestamp;
    if (dbStatus === MessageStatus.DELIVERED) updateData.deliveredAt = status.timestamp;
    if (dbStatus === MessageStatus.READ) updateData.readAt = status.timestamp;
    if (dbStatus === MessageStatus.FAILED) updateData.failedReason = status.errorMessage;

    await this.prisma.message.update({
      where: { id: message.id },
      data: updateData,
    });

    return { updated: message.id, status: dbStatus };
  }
}
