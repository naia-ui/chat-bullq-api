import { Injectable, Logger } from '@nestjs/common';
import { ChatbotNode } from '@prisma/client';
import { ChatbotSessionService } from '../session/chatbot-session.service';
import { ChatbotFlowsRepository } from '../chatbot-flows/chatbot-flows.repository';
import {
  NodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './node-executors/node-executor.interface';
import { MessageNodeExecutor } from './node-executors/message-node.executor';
import { MenuNodeExecutor } from './node-executors/menu-node.executor';
import { ConditionNodeExecutor } from './node-executors/condition-node.executor';
import { WaitNodeExecutor } from './node-executors/wait-node.executor';
import { TransferNodeExecutor } from './node-executors/transfer-node.executor';

export interface EngineResult {
  messages: { type: string; content: Record<string, any> }[];
  transferToHuman: boolean;
  transferDepartmentId?: string;
  sessionEnded: boolean;
}

@Injectable()
export class ChatbotEngineService {
  private readonly logger = new Logger(ChatbotEngineService.name);
  private readonly executors: Map<string, NodeExecutor>;

  constructor(
    private readonly sessionService: ChatbotSessionService,
    private readonly flowsRepo: ChatbotFlowsRepository,
    messageExec: MessageNodeExecutor,
    menuExec: MenuNodeExecutor,
    conditionExec: ConditionNodeExecutor,
    waitExec: WaitNodeExecutor,
    transferExec: TransferNodeExecutor,
  ) {
    this.executors = new Map<string, NodeExecutor>();
    this.executors.set(messageExec.nodeType, messageExec);
    this.executors.set(menuExec.nodeType, menuExec);
    this.executors.set(conditionExec.nodeType, conditionExec);
    this.executors.set(waitExec.nodeType, waitExec);
    this.executors.set(transferExec.nodeType, transferExec);
  }

  async processMessage(
    conversationId: string,
    channelId: string,
    contactExternalId: string,
    incomingText: string,
  ): Promise<EngineResult> {
    const allMessages: EngineResult['messages'] = [];
    let transferToHuman = false;
    let transferDepartmentId: string | undefined;

    let session = await this.sessionService.get(conversationId);

    if (!session) {
      const flow = await this.flowsRepo.findActiveFlowForChannel(channelId);
      if (!flow || !flow.nodes.length) {
        return { messages: [], transferToHuman: false, sessionEnded: true };
      }

      const startNode = flow.nodes.find((n) => n.type === 'START');
      const firstNode = startNode || flow.nodes[0];
      session = await this.sessionService.create(
        conversationId,
        flow.id,
        firstNode.id,
      );

      if (firstNode.type === 'START') {
        const edges = firstNode.edges as any[];
        const nextId = edges[0]?.targetNodeId;
        if (nextId) {
          session = (await this.sessionService.update(conversationId, { currentNodeId: nextId }))!;
        }
      }
    }

    const flow = await this.flowsRepo.findById(session.flowId);
    if (!flow) {
      await this.sessionService.destroy(conversationId);
      return { messages: [], transferToHuman: false, sessionEnded: true };
    }

    const nodesMap = new Map(flow.nodes.map((n) => [n.id, n]));
    let currentNodeId: string | null = session.currentNodeId;
    let iterations = 0;
    const MAX_ITERATIONS = 20;

    while (currentNodeId && iterations < MAX_ITERATIONS) {
      iterations++;
      const node = nodesMap.get(currentNodeId);
      if (!node) break;

      if (node.type === 'END_FLOW') {
        await this.sessionService.destroy(conversationId);
        return { messages: allMessages, transferToHuman, transferDepartmentId, sessionEnded: true };
      }

      const executor = this.executors.get(node.type);
      if (!executor) {
        this.logger.warn(`No executor for node type: ${node.type}`);
        break;
      }

      const ctx: NodeExecutionContext = {
        session,
        nodeData: node.data as Record<string, any>,
        nodeEdges: node.edges as any[],
        incomingMessage: session.waitingForInput ? incomingText : undefined,
        conversationId,
        channelId,
        contactExternalId,
      };

      const result = await executor.execute(ctx);
      allMessages.push(...result.sendMessages);

      if (result.updatedVariables) {
        Object.assign(session.variables, result.updatedVariables);
      }

      if (result.transferToHuman) {
        transferToHuman = true;
        transferDepartmentId = result.transferDepartmentId;
        await this.sessionService.destroy(conversationId);
        return { messages: allMessages, transferToHuman, transferDepartmentId, sessionEnded: true };
      }

      if (result.waitForInput) {
        await this.sessionService.update(conversationId, {
          currentNodeId,
          waitingForInput: true,
          variables: session.variables,
        });
        return { messages: allMessages, transferToHuman: false, sessionEnded: false };
      }

      currentNodeId = result.nextNodeId;
      if (currentNodeId) {
        session = (await this.sessionService.update(conversationId, {
          currentNodeId,
          waitingForInput: false,
          variables: session.variables,
        }))!;
      }
    }

    if (iterations >= MAX_ITERATIONS) {
      this.logger.warn(`Max iterations reached for conversation ${conversationId}`);
    }

    await this.sessionService.destroy(conversationId);
    return { messages: allMessages, transferToHuman, transferDepartmentId, sessionEnded: true };
  }
}
