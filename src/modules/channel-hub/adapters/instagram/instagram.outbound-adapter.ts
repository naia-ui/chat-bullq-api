import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import { NormalizedOutboundMessage, SendResult, RateLimitConfig } from '../../ports/types';
import { InstagramMessageMapper } from './instagram.message-mapper';
import { InstagramHttpClient } from './instagram.http-client';

@Injectable()
export class InstagramOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.INSTAGRAM;
  private readonly logger = new Logger(InstagramOutboundAdapter.name);

  constructor(
    private readonly mapper: InstagramMessageMapper,
    private readonly httpClient: InstagramHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const payload = this.mapper.denormalize(message, contactExternalId);
    const response = await this.httpClient.sendMessage(channel, payload);

    return {
      externalId: response?.message_id || '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(
    channel: Channel,
    contactExternalId: string,
  ): Promise<void> {
    try {
      await this.httpClient.sendMessage(channel, {
        recipient: { id: contactExternalId },
        sender_action: 'typing_on',
      });
    } catch (error: any) {
      this.logger.warn(`IG typing indicator failed: ${error.message}`);
    }
  }

  async getMediaUrl(_channel: Channel, mediaId: string): Promise<string> {
    return mediaId;
  }

  async downloadMedia(_channel: Channel, mediaUrl: string): Promise<Buffer> {
    return this.httpClient.downloadMedia(mediaUrl);
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 200,
      maxPerMinute: 5000,
      windowMs: 60000,
    };
  }
}
