import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

@Injectable()
export class TransferNodeExecutor implements NodeExecutor {
  readonly nodeType = 'TRANSFER';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const message = ctx.nodeData.message || 'Transferindo você para um atendente...';
    const departmentId = ctx.nodeData.departmentId;

    return {
      nextNodeId: null,
      sendMessages: [{ type: 'TEXT', content: { text: message } }],
      waitForInput: false,
      transferToHuman: true,
      transferDepartmentId: departmentId,
    };
  }
}
