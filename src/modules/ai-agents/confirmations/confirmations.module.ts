import { forwardRef, Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { PrismaModule } from '../../../database/prisma.module';
import { ToolsModule } from '../tools/tools.module';
import { PendingActionStorage } from './pending-action.storage';
import { PendingActionService } from './pending-action.service';
import { PendingActionController } from './pending-action.controller';
import {
  PendingActionExecutorProcessor,
  PENDING_ACTION_EXECUTOR_QUEUE,
} from './pending-action-executor.processor';
import { PendingActionCronService } from './pending-action-cron.service';

const executorQueue = BullModule.registerQueue({
  name: PENDING_ACTION_EXECUTOR_QUEUE,
});

/**
 * Destructive-action confirmation module.
 *
 * Provides the infra for high-risk AI tools (grantAccess, resetPassword,
 * transferToHuman, ...) to create a `PendingAction` that requires human
 * approval before execution. Storage is Prisma-backed (`AiPendingAction`).
 *
 * Fase 2.5: includes executor processor that runs the real tool after
 * human approval (built-in transferToHuman OR HTTP skill via
 * `HttpToolExecutorService` with `bypassPendingGate: true`).
 *
 * Uses `forwardRef(() => ToolsModule)` because ToolsModule already imports
 * ConfirmationsModule (for the gate inside HttpToolExecutorService).
 */
@Module({
  imports: [
    PrismaModule,
    forwardRef(() => ToolsModule),
    executorQueue,
  ],
  controllers: [PendingActionController],
  providers: [
    PendingActionStorage,
    PendingActionService,
    PendingActionExecutorProcessor,
    PendingActionCronService,
  ],
  exports: [PendingActionService, executorQueue],
})
export class ConfirmationsModule {}
