import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../../database/prisma.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { AiRunHealthCron } from './ai-run-health.cron';
import { AI_RUN_HEALTH_QUEUE } from './ai-run-health.constants';

@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    BullModule.registerQueue({ name: AI_RUN_HEALTH_QUEUE }),
  ],
  providers: [AiRunHealthCron],
})
export class AiRunHealthModule {}
