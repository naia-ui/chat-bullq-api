import { Module, forwardRef } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../../database/prisma.module';
import { NotificationsModule } from '../../notifications/notifications.module';
import { ZappfyModule } from '../../channel-hub/adapters/zappfy/zappfy.module';
import { HandoffNotificationsService } from './handoff-notifications.service';
import { HandoffExecutionService } from './handoff-execution.service';

/**
 * Módulo neutro pro handoff pra humano — vive fora de `ToolsModule` e de
 * `ConfirmationExecutorModule` de propósito, porque os DOIS precisam
 * importar isso (TransferToHumanTool executa direto; o executor de
 * PendingAction reusa como caminho legado) e um módulo não pode depender
 * do outro sem ciclo (ver comentário em confirmation-executor.module.ts).
 *
 * forwardRef: ZappfyModule → MessagingModule → AiAgentsModule →
 * ToolsModule → HandoffModule → ZappfyModule é um ciclo real, mesmo
 * padrão que outros pontos do código já resolvem assim.
 */
@Module({
  imports: [
    PrismaModule,
    NotificationsModule,
    forwardRef(() => ZappfyModule),
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  providers: [HandoffNotificationsService, HandoffExecutionService],
  exports: [HandoffNotificationsService, HandoffExecutionService],
})
export class HandoffModule {}
