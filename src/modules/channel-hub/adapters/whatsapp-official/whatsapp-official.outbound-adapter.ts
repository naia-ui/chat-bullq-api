import { Injectable, Logger } from '@nestjs/common';
import { ChannelType, Channel } from '@prisma/client';
import { OutboundChannelPort } from '../../ports/outbound-channel.port';
import { NormalizedOutboundMessage, SendResult, RateLimitConfig } from '../../ports/types';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { WhatsAppOfficialHttpClient } from './whatsapp-official.http-client';

@Injectable()
export class WhatsAppOfficialOutboundAdapter implements OutboundChannelPort {
  readonly channelType = ChannelType.WHATSAPP_OFFICIAL;
  private readonly logger = new Logger(WhatsAppOfficialOutboundAdapter.name);

  constructor(
    private readonly mapper: WhatsAppOfficialMessageMapper,
    private readonly httpClient: WhatsAppOfficialHttpClient,
  ) {}

  async sendMessage(
    channel: Channel,
    contactExternalId: string,
    message: NormalizedOutboundMessage,
  ): Promise<SendResult> {
    const payload = this.mapper.denormalize(message, contactExternalId);
    const response = await this.httpClient.sendMessage(channel, payload);

    return {
      externalId: response?.messages?.[0]?.id || '',
      providerResponse: response,
    };
  }

  async sendTypingIndicator(_channel: Channel, _contactExternalId: string): Promise<void> {
    // Meta Cloud API doesn't support typing indicators via API
  }

  async getMediaUrl(channel: Channel, mediaId: string): Promise<string> {
    return this.httpClient.getMediaUrl(channel, mediaId);
  }

  async downloadMedia(channel: Channel, mediaId: string): Promise<Buffer> {
    const url = await this.httpClient.getMediaUrl(channel, mediaId);
    return this.httpClient.downloadMedia(channel, url);
  }

  getRateLimits(): RateLimitConfig {
    return {
      maxPerSecond: 80,
      maxPerMinute: 1000,
      windowMs: 60000,
    };
  }
}
