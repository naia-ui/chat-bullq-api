import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

@Injectable()
export class MessageNodeExecutor implements NodeExecutor {
  readonly nodeType = 'MESSAGE';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const text = this.interpolate(ctx.nodeData.message || '', ctx.session.variables);
    const nextNodeId = ctx.nodeEdges[0]?.targetNodeId || null;

    return {
      nextNodeId,
      sendMessages: [{ type: 'TEXT', content: { text } }],
      waitForInput: false,
    };
  }

  private interpolate(template: string, variables: Record<string, any>): string {
    return template.replace(/\{\{(\w+)\}\}/g, (_, key) => variables[key] ?? `{{${key}}}`);
  }
}
