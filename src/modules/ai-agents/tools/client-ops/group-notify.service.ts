import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import {
  MessageContentType,
  MessageDirection,
  MessageStatus,
} from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { RealtimeGateway } from '../../../realtime/realtime.gateway';

/**
 * Envio proativo de mensagem pra um grupo WhatsApp do cliente (JID vindo
 * do Hoppe), usando a MESMA fila outbound que o replyToConversation — ou
 * seja, sem dependência externa nenhuma. Se o grupo for a própria conversa
 * onde o agente está falando, devolve skipped pra evitar mensagem dobrada.
 */
@Injectable()
export class GroupNotifyService {
  private readonly logger = new Logger(GroupNotifyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async notifyGroupByJid(input: {
    organizationId: string;
    groupJid: string;
    text: string;
    currentConversationId: string;
    senderName: string;
  }): Promise<{ sent: boolean; reason?: string }> {
    const contactChannel = await this.prisma.contactChannel.findFirst({
      where: {
        externalId: input.groupJid,
        channel: { organizationId: input.organizationId },
      },
      select: { contactId: true, channelId: true, externalId: true },
    });
    if (!contactChannel) {
      return {
        sent: false,
        reason: `Grupo ${input.groupJid} não encontrado nos canais da organização`,
      };
    }

    const conversation = await this.prisma.conversation.findFirst({
      where: {
        contactId: contactChannel.contactId,
        channelId: contactChannel.channelId,
      },
      orderBy: { lastMessageAt: 'desc' },
      select: { id: true },
    });
    if (!conversation) {
      return { sent: false, reason: 'Grupo sem conversa registrada' };
    }
    if (conversation.id === input.currentConversationId) {
      // O agente já está falando NESSE grupo — a resposta normal dele cobre.
      return { sent: false, reason: 'skipped_same_conversation' };
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId: conversation.id,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text: input.text },
        status: MessageStatus.QUEUED,
        senderName: input.senderName,
        metadata: { source: 'sofia-group-notify' },
      },
    });
    await this.prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastMessageAt: new Date() },
    });
    this.realtime.emitToChannel(contactChannel.channelId, 'message:new', {
      message,
      conversationId: conversation.id,
      contactId: contactChannel.contactId,
    });
    this.realtime.emitToConversation(conversation.id, 'message:new', {
      message,
    });
    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: contactChannel.channelId,
        contactExternalId: contactChannel.externalId,
        message: {
          type: MessageContentType.TEXT,
          content: { text: input.text },
        },
      },
      {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );

    this.logger.log(
      `Aviso enviado pro grupo ${input.groupJid} (conv ${conversation.id})`,
    );
    return { sent: true };
  }
}
