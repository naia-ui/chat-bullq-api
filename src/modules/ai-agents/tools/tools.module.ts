import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from '../../../database/prisma.module';
import { RealtimeModule } from '../../realtime/realtime.module';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';
import { ListAvailableAgentsTool } from './builtin/list-available-agents.tool';
import { DelegateToAgentTool } from './builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './builtin/hand-back-to-orchestrator.tool';
import { ToolRegistry } from './tool-registry.service';
import { HttpToolExecutorService } from './http-tool-executor.service';
import { ConfigModule } from '@nestjs/config';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    RealtimeModule,
    BullModule.registerQueue({ name: 'outbound-messages' }),
  ],
  providers: [
    ReplyToConversationTool,
    TransferToHumanTool,
    TagConversationTool,
    ListAvailableAgentsTool,
    DelegateToAgentTool,
    HandBackToOrchestratorTool,
    ToolRegistry,
    HttpToolExecutorService,
  ],
  exports: [ToolRegistry, HttpToolExecutorService],
})
export class ToolsModule {}
