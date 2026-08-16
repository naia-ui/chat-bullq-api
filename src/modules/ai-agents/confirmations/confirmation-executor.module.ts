import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { PrismaModule } from '../../../database/prisma.module';
import { ToolsModule } from '../tools/tools.module';
import { ChannelHubModule } from '../../channel-hub/channel-hub.module';
import { ConfirmationsModule } from './confirmations.module';
import { PendingActionExecutorProcessor } from './pending-action-executor.processor';
import { PendingActionCronService } from './pending-action-cron.service';
import { HandoffNotificationsService } from './handoff-notifications.service';

/**
 * Module separado pra quebrar ciclo de DI:
 *   ToolsModule → ConfirmationsModule (gating)
 *   ConfirmationExecutorModule → ToolsModule + ConfirmationsModule (executor)
 *
 * O processor + cron NÃO podem viver dentro do ConfirmationsModule porque
 * isso criaria ciclo (Tools → Confirmations → Tools). Mantendo aqui, Tools
 * importa Confirmations sem ciclo, e Executor importa ambos.
 *
 * AiAgentsModule importa este module — basta isso pro processor subir e
 * o cron registrar o repeatable job.
 */
@Module({
  imports: [
    PrismaModule,
    ToolsModule,
    ConfirmationsModule,
    // Pro ping interno de handoff (ChannelAdapterRegistry.getOutbound).
    // forwardRef: ChannelHubModule → MessagingModule → AiAgentsModule →
    // ConfirmationExecutorModule é um ciclo real (mesmo padrão que o
    // ZappfyModule já resolve pro lado channel-hub ↔ messaging).
    forwardRef(() => ChannelHubModule),
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  providers: [
    PendingActionExecutorProcessor,
    PendingActionCronService,
    HandoffNotificationsService,
  ],
})
export class ConfirmationExecutorModule {}
