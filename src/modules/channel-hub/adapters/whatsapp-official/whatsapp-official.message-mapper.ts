import { Injectable } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import {
  NormalizedInboundMessage,
  NormalizedOutboundMessage,
  MessageContentType,
  StatusUpdate,
} from '../../ports/types';

@Injectable()
export class WhatsAppOfficialMessageMapper {
  normalizeInbound(
    message: Record<string, any>,
    contact: Record<string, any>,
  ): NormalizedInboundMessage | null {
    if (!message) return null;

    const result: NormalizedInboundMessage = {
      externalMessageId: message.id,
      externalContactId: message.from,
      contactName: contact?.profile?.name,
      contactPhone: message.from,
      channelType: ChannelType.WHATSAPP_OFFICIAL,
      timestamp: new Date(parseInt(message.timestamp, 10) * 1000),
      type: this.resolveContentType(message),
      content: this.extractContent(message),
      isForwarded: !!message.context?.forwarded,
      rawPayload: message,
    };

    if (message.context?.id) {
      result.replyTo = { externalMessageId: message.context.id };
    }

    return result;
  }

  normalizeStatus(status: Record<string, any>): StatusUpdate | null {
    if (!status?.id) return null;

    const statusMap: Record<string, StatusUpdate['status']> = {
      sent: 'sent',
      delivered: 'delivered',
      read: 'read',
      failed: 'failed',
    };

    const mapped = statusMap[status.status];
    if (!mapped) return null;

    return {
      externalMessageId: status.id,
      status: mapped,
      timestamp: new Date(parseInt(status.timestamp, 10) * 1000),
      errorMessage: status.errors?.[0]?.message,
    };
  }

  denormalize(
    message: NormalizedOutboundMessage,
    contactExternalId: string,
  ): Record<string, any> {
    const base = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: contactExternalId,
    };

    switch (message.type) {
      case MessageContentType.TEXT:
        return { ...base, type: 'text', text: { body: message.content.text } };

      case MessageContentType.IMAGE:
        return {
          ...base,
          type: 'image',
          image: {
            link: message.content.mediaUrl,
            caption: message.content.caption,
          },
        };

      case MessageContentType.AUDIO:
        return {
          ...base,
          type: 'audio',
          audio: { link: message.content.mediaUrl },
        };

      case MessageContentType.VIDEO:
        return {
          ...base,
          type: 'video',
          video: {
            link: message.content.mediaUrl,
            caption: message.content.caption,
          },
        };

      case MessageContentType.DOCUMENT:
        return {
          ...base,
          type: 'document',
          document: {
            link: message.content.mediaUrl,
            filename: message.content.fileName,
            caption: message.content.caption,
          },
        };

      case MessageContentType.STICKER:
        return {
          ...base,
          type: 'sticker',
          sticker: { link: message.content.mediaUrl },
        };

      case MessageContentType.LOCATION:
        return {
          ...base,
          type: 'location',
          location: {
            latitude: message.content.latitude,
            longitude: message.content.longitude,
          },
        };

      case MessageContentType.REACTION:
        return {
          ...base,
          type: 'reaction',
          reaction: {
            message_id: message.content.reaction?.targetMessageId,
            emoji: message.content.reaction?.emoji,
          },
        };

      case MessageContentType.TEMPLATE:
        return {
          ...base,
          type: 'template',
          template: message.content as any,
        };

      default:
        return { ...base, type: 'text', text: { body: message.content.text || '' } };
    }
  }

  private resolveContentType(msg: Record<string, any>): MessageContentType {
    const type = msg.type;
    const map: Record<string, MessageContentType> = {
      text: MessageContentType.TEXT,
      image: MessageContentType.IMAGE,
      audio: MessageContentType.AUDIO,
      video: MessageContentType.VIDEO,
      document: MessageContentType.DOCUMENT,
      sticker: MessageContentType.STICKER,
      location: MessageContentType.LOCATION,
      reaction: MessageContentType.REACTION,
      interactive: MessageContentType.INTERACTIVE,
      button: MessageContentType.INTERACTIVE,
      template: MessageContentType.TEMPLATE,
    };
    return map[type] || MessageContentType.TEXT;
  }

  private extractContent(msg: Record<string, any>): NormalizedInboundMessage['content'] {
    switch (msg.type) {
      case 'text':
        return { text: msg.text?.body };
      case 'image':
        return {
          mediaId: msg.image?.id,
          mimeType: msg.image?.mime_type,
          caption: msg.image?.caption,
        };
      case 'audio':
        return {
          mediaId: msg.audio?.id,
          mimeType: msg.audio?.mime_type,
        };
      case 'video':
        return {
          mediaId: msg.video?.id,
          mimeType: msg.video?.mime_type,
          caption: msg.video?.caption,
        };
      case 'document':
        return {
          mediaId: msg.document?.id,
          mimeType: msg.document?.mime_type,
          fileName: msg.document?.filename,
          caption: msg.document?.caption,
        };
      case 'sticker':
        return {
          mediaId: msg.sticker?.id,
          mimeType: msg.sticker?.mime_type,
        };
      case 'location':
        return {
          latitude: msg.location?.latitude,
          longitude: msg.location?.longitude,
          text: msg.location?.name || msg.location?.address,
        };
      case 'reaction':
        return {
          reaction: {
            emoji: msg.reaction?.emoji,
            targetMessageId: msg.reaction?.message_id,
          },
        };
      case 'interactive':
        if (msg.interactive?.type === 'button_reply') {
          return {
            interactive: { type: 'button', buttonId: msg.interactive.button_reply?.id },
            text: msg.interactive.button_reply?.title,
          };
        }
        if (msg.interactive?.type === 'list_reply') {
          return {
            interactive: { type: 'list', listRowId: msg.interactive.list_reply?.id },
            text: msg.interactive.list_reply?.title,
          };
        }
        return { text: '[Interactive message]' };
      default:
        return { text: `[${msg.type || 'unknown'}]` };
    }
  }
}
