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
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Sends a TEXT message to the contact on behalf of the agent. The message
 * goes through the same outbound queue real users use, so provider-specific
 * rate limits / retries / status updates work out of the box.
 */
@Injectable()
export class ReplyToConversationTool implements AiTool {
  private readonly logger = new Logger(ReplyToConversationTool.name);

  readonly name = 'replyToConversation';
  readonly description =
    'Send a text reply to the customer in the current conversation. Use this when you have an answer to give. Keep replies concise and natural.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['text'],
    properties: {
      text: {
        type: 'string',
        description:
          'The exact message text to send to the customer. No system tags, no markdown for headers, plain text only.',
        minLength: 1,
        maxLength: 4000,
      },
    },
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly realtime: RealtimeGateway,
    @InjectQueue('outbound-messages') private readonly outboundQueue: Queue,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const text = String(input.text ?? '').trim();
    if (!text) {
      return { output: { ok: false, error: 'text is empty' } };
    }

    const [agent, contactChannel] = await Promise.all([
      this.prisma.aiAgent.findUnique({
        where: { id: ctx.agentId },
        select: { name: true },
      }),
      this.prisma.contactChannel.findFirst({
        where: { contactId: ctx.contactId, channelId: ctx.channelId },
        select: { externalId: true },
      }),
    ]);

    if (!contactChannel?.externalId) {
      this.logger.error(
        `No contactChannel for contact ${ctx.contactId} on channel ${ctx.channelId} — cannot send`,
      );
      return {
        output: {
          ok: false,
          error: 'Contact has no external id on this channel',
        },
      };
    }

    const message = await this.prisma.message.create({
      data: {
        conversationId: ctx.conversationId,
        direction: MessageDirection.OUTBOUND,
        type: MessageContentType.TEXT,
        content: { text },
        status: MessageStatus.QUEUED,
        senderName: agent?.name ?? 'AI',
        metadata: { aiAgentId: ctx.agentId, runId: ctx.runId },
      },
    });

    await this.prisma.conversation.update({
      where: { id: ctx.conversationId },
      data: { lastMessageAt: new Date() },
    });

    this.realtime.emitToChannel(ctx.channelId, 'message:new', {
      message,
      conversationId: ctx.conversationId,
      contactId: ctx.contactId,
    });
    this.realtime.emitToConversation(ctx.conversationId, 'message:new', {
      message,
    });

    await this.outboundQueue.add(
      'send-outbound',
      {
        messageId: message.id,
        channelId: ctx.channelId,
        contactExternalId: contactChannel.externalId,
        message: {
          type: MessageContentType.TEXT,
          content: { text },
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
      `Agent ${ctx.agentId} replied to conv ${ctx.conversationId} (msg ${message.id})`,
    );

    return {
      output: { ok: true, messageId: message.id },
      finalAction: 'REPLIED',
    };
  }
}
