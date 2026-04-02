import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { DepartmentsController } from './departments/departments.controller';
import { DepartmentsService } from './departments/departments.service';
import { DepartmentsRepository } from './departments/departments.repository';
import { RouterService } from './router.service';
import { SlaService } from './sla/sla.service';
import { SlaTimerProcessor } from './sla/sla-timer.processor';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'conversation-router' },
      { name: 'sla-timers' },
    ),
    MessagingModule,
    NotificationsModule,
  ],
  controllers: [DepartmentsController],
  providers: [DepartmentsRepository, DepartmentsService, RouterService, SlaService, SlaTimerProcessor],
  exports: [DepartmentsService, DepartmentsRepository, RouterService, SlaService],
})
export class RoutingModule {}
