import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ZappfyInboundAdapter } from './zappfy.inbound-adapter';
import { ZappfyOutboundAdapter } from './zappfy.outbound-adapter';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';
import { ZappfySyncAdapter } from './zappfy.sync-adapter';
import { ZappfyContactEnricherService } from './zappfy-contact-enricher.service';
import { MessagingModule } from '../../../messaging/messaging.module';
import { AvatarHydrationProcessor } from '../../avatars/avatar-hydration.processor';
import { AVATAR_HYDRATION_QUEUE } from '../../avatars/avatar-hydration.constants';

@Module({
  imports: [
    // O enricher re-hospeda a foto de perfil pelo UploadsService, que vive no
    // MessagingModule — mesmo forwardRef do Gmail/WhatsApp oficial (ciclo
    // channel-hub ↔ messaging).
    forwardRef(() => MessagingModule),
    BullModule.registerQueue({ name: AVATAR_HYDRATION_QUEUE }),
  ],
  providers: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyMessageMapper,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
    AvatarHydrationProcessor,
  ],
  exports: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
  ],
})
export class ZappfyModule {}
