import { Injectable } from '@nestjs/common';
import { NodeExecutor, NodeExecutionContext, NodeExecutionResult } from './node-executor.interface';

@Injectable()
export class ConditionNodeExecutor implements NodeExecutor {
  readonly nodeType = 'CONDITION';

  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const { variable, operator, value } = ctx.nodeData as {
      variable: string;
      operator: 'equals' | 'not_equals' | 'contains' | 'gt' | 'lt';
      value: string;
    };

    const actual = String(ctx.session.variables[variable] ?? '');
    let conditionMet = false;

    switch (operator) {
      case 'equals': conditionMet = actual === value; break;
      case 'not_equals': conditionMet = actual !== value; break;
      case 'contains': conditionMet = actual.toLowerCase().includes(value.toLowerCase()); break;
      case 'gt': conditionMet = parseFloat(actual) > parseFloat(value); break;
      case 'lt': conditionMet = parseFloat(actual) < parseFloat(value); break;
    }

    const trueEdge = ctx.nodeEdges.find((e) => e.condition === 'true');
    const falseEdge = ctx.nodeEdges.find((e) => e.condition === 'false');
    const nextNodeId = conditionMet
      ? (trueEdge?.targetNodeId || ctx.nodeEdges[0]?.targetNodeId || null)
      : (falseEdge?.targetNodeId || ctx.nodeEdges[1]?.targetNodeId || null);

    return { nextNodeId, sendMessages: [], waitForInput: false };
  }
}
