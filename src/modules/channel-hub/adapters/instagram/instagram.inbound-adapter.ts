import { Injectable, Logger } from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import * as crypto from 'crypto';
import { InboundChannelPort } from '../../ports/inbound-channel.port';
import { WebhookParseResult, VerificationResponse } from '../../ports/types';
import { InstagramMessageMapper } from './instagram.message-mapper';

@Injectable()
export class InstagramInboundAdapter implements InboundChannelPort {
  readonly channelType = ChannelType.INSTAGRAM;
  private readonly logger = new Logger(InstagramInboundAdapter.name);

  constructor(private readonly mapper: InstagramMessageMapper) {}

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
        const messagingEvents = entry?.messaging || [];
        for (const event of messagingEvents) {
          if (event.message) {
            const normalized = this.mapper.normalizeInbound(event);
            if (normalized) {
              result.messages.push(normalized);
            }
          }
          if (event.delivery) {
            const status = this.mapper.normalizeStatus(event);
            if (status) {
              result.statuses.push(status);
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Failed to parse Instagram webhook: ${error.message}`);
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
      this.logger.log('Instagram webhook verification successful');
      return { statusCode: 200, body: challenge };
    }

    this.logger.warn('Instagram webhook verification failed');
    return { statusCode: 403, body: { error: 'Verification failed' } };
  }
}
