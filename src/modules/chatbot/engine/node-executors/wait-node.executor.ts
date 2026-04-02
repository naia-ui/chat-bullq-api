import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

@Injectable()
export class WaitNodeExecutor implements NodeExecutor {
  readonly nodeType = 'WAIT';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    if (!ctx.incomingMessage) {
      const prompt = ctx.nodeData.prompt || 'Aguardando sua resposta...';
      return {
        nextNodeId: null,
        sendMessages: prompt ? [{ type: 'TEXT', content: { text: prompt } }] : [],
        waitForInput: true,
      };
    }

    const variableName = ctx.nodeData.saveAs || 'lastInput';
    const nextNodeId = ctx.nodeEdges[0]?.targetNodeId || null;

    return {
      nextNodeId,
      sendMessages: [],
      waitForInput: false,
      updatedVariables: { [variableName]: ctx.incomingMessage },
    };
  }
}
