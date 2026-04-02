import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

@Injectable()
export class InstagramMessageMapper {
  normalizeInbound(messaging: Record<string, any>): NormalizedInboundMessage | null {
    const senderId = messaging.sender?.id;
    const message = messaging.message;
    if (!senderId || !message) return null;

    const result: NormalizedInboundMessage = {
      externalMessageId: message.mid,
      externalContactId: senderId,
      channelType: ChannelType.INSTAGRAM,
      timestamp: new Date(messaging.timestamp),
      type: this.resolveContentType(message),
      content: this.extractContent(message),
      rawPayload: messaging,
    };

    if (message.reply_to?.mid) {
      result.replyTo = { externalMessageId: message.reply_to.mid };
    }

    return result;
  }

  normalizeStatus(messaging: Record<string, any>): StatusUpdate | null {
    const delivery = messaging.delivery;
    if (!delivery?.mids?.length) return null;

    return {
      externalMessageId: delivery.mids[0],
      status: 'delivered',
      timestamp: new Date(messaging.timestamp),
    };
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): Record<string, any> {
    const base = { recipient: { id: contactExternalId } };

    switch (message.type) {
      case MessageContentType.TEXT:
        return { ...base, message: { text: message.content.text } };

      case MessageContentType.IMAGE:
        return {
          ...base,
          message: {
            attachment: {
              type: 'image',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      case MessageContentType.AUDIO:
        return {
          ...base,
          message: {
            attachment: {
              type: 'audio',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      case MessageContentType.VIDEO:
        return {
          ...base,
          message: {
            attachment: {
              type: 'video',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      case MessageContentType.DOCUMENT:
        return {
          ...base,
          message: {
            attachment: {
              type: 'file',
              payload: { url: message.content.mediaUrl, is_reusable: true },
            },
          },
        };

      default:
        return { ...base, message: { text: message.content.text || '' } };
    }
  }

  private resolveContentType(msg: Record<string, any>): MessageContentType {
    if (msg.text) return MessageContentType.TEXT;
    if (msg.attachments?.length) {
      const type = msg.attachments[0].type;
      const map: Record<string, MessageContentType> = {
        image: MessageContentType.IMAGE,
        audio: MessageContentType.AUDIO,
        video: MessageContentType.VIDEO,
        file: MessageContentType.DOCUMENT,
        share: MessageContentType.TEXT,
        story_mention: MessageContentType.TEXT,
        reel: MessageContentType.VIDEO,
      };
      return map[type] || MessageContentType.TEXT;
    }
    return MessageContentType.TEXT;
  }

  private extractContent(msg: Record<string, any>): NormalizedInboundMessage['content'] {
    if (msg.text) {
      return { text: msg.text };
    }

    if (msg.attachments?.length) {
      const att = msg.attachments[0];
      const payload = att.payload || {};

      switch (att.type) {
        case 'image':
          return { mediaUrl: payload.url, mimeType: 'image/jpeg' };
        case 'audio':
          return { mediaUrl: payload.url, mimeType: 'audio/mp4' };
        case 'video':
        case 'reel':
          return { mediaUrl: payload.url, mimeType: 'video/mp4' };
        case 'file':
          return { mediaUrl: payload.url };
        case 'share':
          return { text: payload.url || '[Shared content]' };
        case 'story_mention':
          return { text: '[Story mention]', mediaUrl: payload.url };
        default:
          return { text: `[${att.type}]` };
      }
    }

    return { text: '[Unsupported message]' };
  }
}
