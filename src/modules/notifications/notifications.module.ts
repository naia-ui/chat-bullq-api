import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { NotificationsController } from './notifications.controller';
import { NotificationsService } from './notifications.service';
import { NotificationsRepository } from './notifications.repository';
import { NotificationProcessor } from './notification.processor';
import { EmailAlertService } from './email-alert.service';

@Module({
  imports: [
    BullModule.registerQueue({ name: 'notifications' }),
  ],
  controllers: [NotificationsController],
  providers: [
    NotificationsService,
    NotificationsRepository,
    NotificationProcessor,
    EmailAlertService,
  ],
  exports: [NotificationsService, EmailAlertService],
})
export class NotificationsModule {}
