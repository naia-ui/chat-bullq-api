import { Module } from '@nestjs/common';
import { InstagramInboundAdapter } from './instagram.inbound-adapter';
import { InstagramOutboundAdapter } from './instagram.outbound-adapter';
import { InstagramMessageMapper } from './instagram.message-mapper';
import { InstagramHttpClient } from './instagram.http-client';

@Module({
  providers: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramMessageMapper,
    InstagramHttpClient,
  ],
  exports: [
    InstagramInboundAdapter,
    InstagramOutboundAdapter,
    InstagramHttpClient,
  ],
})
export class InstagramModule {}
