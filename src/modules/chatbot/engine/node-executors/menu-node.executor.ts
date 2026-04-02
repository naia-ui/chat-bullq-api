import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

@Injectable()
export class MenuNodeExecutor implements NodeExecutor {
  readonly nodeType = 'MENU';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const { title, options } = ctx.nodeData as {
      title: string;
      options: { label: string; value: string }[];
    };

    if (!ctx.incomingMessage) {
      const menuText = [
        title || 'Escolha uma opção:',
        '',
        ...options.map((opt, i) => `${i + 1}. ${opt.label}`),
      ].join('\n');

      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text: menuText } }],
        waitForInput: true,
      };
    }

    const input = ctx.incomingMessage.trim();
    const selectedIndex = parseInt(input, 10) - 1;
    const selectedByNumber = options[selectedIndex];
    const selectedByValue = options.find(
      (o) => o.value.toLowerCase() === input.toLowerCase() || o.label.toLowerCase() === input.toLowerCase(),
    );
    const selected = selectedByNumber || selectedByValue;

    if (!selected) {
      return {
        nextNodeId: null,
        sendMessages: [{ type: 'TEXT', content: { text: 'Opção inválida. Tente novamente.' } }],
        waitForInput: true,
      };
    }

    const matchingEdge = ctx.nodeEdges.find((e) => e.condition === selected.value);
    const nextNodeId = matchingEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null;

    return {
      nextNodeId,
      sendMessages: [],
      waitForInput: false,
      updatedVariables: { lastMenuSelection: selected.value },
    };
  }
}
