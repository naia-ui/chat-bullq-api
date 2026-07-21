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
    const base: Record<string, any> = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: contactExternalId,
    };
    // Meta Cloud API: replyTo vira `context.message_id` no payload top-level.
    // O WhatsApp do cliente renderiza nossa msg com a "bolha-resposta" sobre
    // a mensagem original, exatamente como uma reply nativa.
    // Nota: 'reaction' e 'template' não aceitam context — evitamos abaixo.
    if (message.replyTo?.externalMessageId) {
      base.context = { message_id: message.replyTo.externalMessageId };
    }

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

      case MessageContentType.REACTION: {
        // Cloud API reaction NÃO aceita context — strip antes de enviar.
        const { context, ...withoutCtx } = base;
        void context;
        return {
          ...withoutCtx,
          type: 'reaction',
          reaction: {
            message_id: message.content.reaction?.targetMessageId,
            emoji: message.content.reaction?.emoji,
          },
        };
      }

      case MessageContentType.TEMPLATE: {
        // Templates HSM também não aceitam context.
        const { context, ...withoutCtx } = base;
        void context;
        return {
          ...withoutCtx,
          type: 'template',
          template: message.content as any,
        };
      }

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
        // Resposta ao pedido de permissão de ligação — o cliente não digitou
        // nada, mas a conversa fica sem sentido se a bolha vier vazia.
        if (msg.interactive?.type === 'call_permission_reply') {
          const accepted = msg.interactive.call_permission_reply?.response === 'accept';
          return {
            interactive: { type: 'button' },
            text: accepted
              ? 'Permitiu chamadas de voz'
              : 'Recusou chamadas de voz',
          };
        }
        return { text: `[${msg.interactive?.type || 'interativo'}]` };
      // Resposta a botão de TEMPLATE (quick reply). Chega como `button`, não
      // como `interactive` — sem esse case a bolha virava "[button]".
      case 'button':
        return {
          interactive: { type: 'button', buttonId: msg.button?.payload },
          text: msg.button?.text || msg.button?.payload || '[botão]',
        };
      // Cartão de contato. `contacts[].vcard` vem em base64 aqui (diferente
      // do não-oficial, que manda o vCard cru), mas `name` e `phones` já vêm
      // estruturados — usamos eles e ignoramos o vCard.
      case 'contacts':
        return { text: this.formatContacts(msg.contacts) };
      default:
        return { text: `[${msg.type || 'unknown'}]` };
    }
  }

  /** Mesmo formato do canal não-oficial: "Contato: Fulano" + telefones. */
  private formatContacts(contacts: any): string {
    if (!Array.isArray(contacts) || contacts.length === 0) return '[contato]';
    return contacts
      .map((c) => {
        const name =
          c?.name?.formatted_name ||
          [c?.name?.first_name, c?.name?.last_name].filter(Boolean).join(' ') ||
          'sem nome';
        const phones = (c?.phones ?? [])
          .map((p: any) => p?.phone)
          .filter(Boolean);
        return [`Contato: ${name}`, ...phones].join('\n');
      })
      .join('\n\n');
  }
}
