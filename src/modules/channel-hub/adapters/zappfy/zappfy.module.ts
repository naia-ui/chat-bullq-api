import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ZappfyInboundAdapter } from './zappfy.inbound-adapter';
import { ZappfyOutboundAdapter } from './zappfy.outbound-adapter';
import { ZappfyMessageMapper } from './zappfy.message-mapper';
import { ZappfyHttpClient } from './zappfy.http-client';
import { ZappfySyncAdapter } from './zappfy.sync-adapter';
import { ZappfyContactEnricherService } from './zappfy-contact-enricher.service';
import { ZappfyConnectionHealthCron } from './zappfy-connection-health.cron';
import { ZAPPFY_HEALTH_QUEUE } from './zappfy-health.constants';
import { MessagingModule } from '../../../messaging/messaging.module';
import { NotificationsModule } from '../../../notifications/notifications.module';
import { AvatarHydrationProcessor } from '../../avatars/avatar-hydration.processor';
import { AVATAR_HYDRATION_QUEUE } from '../../avatars/avatar-hydration.constants';

@Module({
  imports: [
    // O enricher re-hospeda a foto de perfil pelo UploadsService, que vive no
    // MessagingModule — mesmo forwardRef do Gmail/WhatsApp oficial (ciclo
    // channel-hub ↔ messaging).
    forwardRef(() => MessagingModule),
    // EmailAlertService (alerta de desconexão do ZappfyConnectionHealthCron).
    NotificationsModule,
    BullModule.registerQueue(
      { name: AVATAR_HYDRATION_QUEUE },
      { name: ZAPPFY_HEALTH_QUEUE },
    ),
  ],
  providers: [
    ZappfyInboundAdapter,
    ZappfyOutboundAdapter,
    ZappfyMessageMapper,
    ZappfyHttpClient,
    ZappfySyncAdapter,
    ZappfyContactEnricherService,
    AvatarHydrationProcessor,
    ZappfyConnectionHealthCron,
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
