import { Module } from '@nestjs/common';
import { WhatsAppOfficialInboundAdapter } from './whatsapp-official.inbound-adapter';
import { WhatsAppOfficialOutboundAdapter } from './whatsapp-official.outbound-adapter';
import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';
import { WhatsAppOfficialHttpClient } from './whatsapp-official.http-client';

@Module({
  providers: [
    WhatsAppOfficialInboundAdapter,
    WhatsAppOfficialOutboundAdapter,
    WhatsAppOfficialMessageMapper,
    WhatsAppOfficialHttpClient,
  ],
  exports: [
    WhatsAppOfficialInboundAdapter,
    WhatsAppOfficialOutboundAdapter,
    WhatsAppOfficialHttpClient,
  ],
})
export class WhatsAppOfficialModule {}
