import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import { InboundChannelPort } from '../../ports/inbound-channel.port';
import { WebhookParseResult, VerificationResponse } from '../../ports/types';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';

@Injectable()
export class WhatsAppOfficialInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_OFFICIAL;
  private readonly logger = new Logger(WhatsAppOfficialInboundAdapter.name);

  constructor(private readonly mapper: WhatsAppOfficialMessageMapper) {}

  validateWebhook(
    headers: Record<string, string>,
    rawBody: Buffer,
    webhookSecret?: string,
  ): boolean {
    if (!webhookSecret) return true;

    const signature = headers['x-hub-signature-256'];
    if (!signature) return false;

    const expected = 'sha256=' +
      crypto.createHmac('sha256', webhookSecret).update(rawBody).digest('hex');

    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expected),
    );
  }

  parseWebhook(payload: unknown): WebhookParseResult {
    const result: WebhookParseResult = {
      messages: [],
      statuses: [],
      errors: [],
    };

    try {
      const body = payload as Record<string, any>;
      const entries = body?.entry || [];

      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          const value = change?.value;
          if (!value) continue;

          const contacts = value.contacts || [];
          const messages = value.messages || [];
          const statuses = value.statuses || [];

          for (const msg of messages) {
            const contact = contacts.find(
              (c: any) => c.wa_id === msg.from,
            ) || {};
            const normalized = this.mapper.normalizeInbound(msg, contact);
            if (normalized) {
              result.messages.push(normalized);
            }
          }

          for (const status of statuses) {
            const normalized = this.mapper.normalizeStatus(status);
            if (normalized) {
              result.statuses.push(normalized);
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse WA Official webhook: ${error.message}`);
      result.errors.push({
        code: 'PARSE_ERROR',
        message: error.message,
        rawData: payload,
      });
    }

    return result;
  }

  handleVerification(
    query: Record<string, string>,
    webhookSecret?: string,
  ): VerificationResponse {
    const mode = query['hub.mode'];
    const token = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode === 'subscribe' && token === webhookSecret) {
      this.logger.log('Meta webhook verification successful');
      return { statusCode: 200, body: challenge };
    }

    this.logger.warn('Meta webhook verification failed');
    return { statusCode: 403, body: { error: 'Verification failed' } };
  }
}
