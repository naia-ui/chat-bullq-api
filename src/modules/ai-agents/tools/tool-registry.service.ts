import { Injectable, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { AiAgentKind } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { AiTool as BuiltInToolImpl, toLlmDefinition } from './tool.types';
import { LlmToolDefinition } from '../llm/llm.types';
import { ReplyToConversationTool } from './builtin/reply-to-conversation.tool';
import { TransferToHumanTool } from './builtin/transfer-to-human.tool';
import { TagConversationTool } from './builtin/tag-conversation.tool';
import { ListAvailableAgentsTool } from './builtin/list-available-agents.tool';
import { DelegateToAgentTool } from './builtin/delegate-to-agent.tool';
import { HandBackToOrchestratorTool } from './builtin/hand-back-to-orchestrator.tool';

/**
 * Central catalog of every tool available to AI agents. Each tool is also
 * scoped to which agent kinds can use it — orchestrators get routing tools,
 * workers get hand-back tools, and shared tools (reply, transfer, tag) are
 * available to both.
 */
@Injectable()
export class ToolRegistry implements OnModuleInit {
  private readonly logger = new Logger(ToolRegistry.name);
  private readonly tools = new Map<string, BuiltInToolImpl>();
  private readonly scope = new Map<string, Set<AiAgentKind>>();

  constructor(
    private readonly prisma: PrismaService,
    reply: ReplyToConversationTool,
    transfer: TransferToHumanTool,
    tag: TagConversationTool,
    listAgents: ListAvailableAgentsTool,
    delegate: DelegateToAgentTool,
    handBack: HandBackToOrchestratorTool,
  ) {
    // Shared
    this.register(reply, ['ORCHESTRATOR', 'WORKER']);
    this.register(transfer, ['ORCHESTRATOR', 'WORKER']);
    this.register(tag, ['ORCHESTRATOR', 'WORKER']);

    // Orchestrator-only
    this.register(listAgents, ['ORCHESTRATOR']);
    this.register(delegate, ['ORCHESTRATOR']);

    // Worker-only
    this.register(handBack, ['WORKER']);

    this.logger.log(
      `Registered ${this.tools.size} built-in tools: ${[...this.tools.keys()].join(', ')}`,
    );
  }

  /**
   * On boot, mirror every built-in tool into the database so the UI can
   * list/atribuir them just like custom HTTP tools. Idempotent — uses
   * upsert keyed on (organizationId=null, name).
   */
  async onModuleInit() {
    for (const [name, tool] of this.tools) {
      try {
        // Prisma's typed unique on a nullable column doesn't accept `null`,
        // so we do a manual find+create/update for the BUILTIN row (org=null).
        const existing = await this.prisma.aiTool.findFirst({
          where: { name, organizationId: null, source: 'BUILTIN' },
        });
        if (existing) {
          await this.prisma.aiTool.update({
            where: { id: existing.id },
            data: {
              description: tool.description,
              parameters: tool.parameters as object,
              isActive: true,
            },
          });
        } else {
          await this.prisma.aiTool.create({
            data: {
              name,
              description: tool.description,
              source: 'BUILTIN',
              parameters: tool.parameters as object,
              organizationId: null,
              isActive: true,
            },
          });
        }
      } catch (err: any) {
        this.logger.warn(
          `Failed to mirror built-in tool ${name}: ${err?.message ?? err}`,
        );
      }
    }
    this.logger.log(`Built-in tools mirrored to DB.`);
  }

  private register(tool: BuiltInToolImpl, kinds: AiAgentKind[]): void {
    if (this.tools.has(tool.name)) {
      throw new Error(`Duplicate tool registration: ${tool.name}`);
    }
    this.tools.set(tool.name, tool);
    this.scope.set(tool.name, new Set(kinds));
  }

  get(name: string): BuiltInToolImpl {
    const tool = this.tools.get(name);
    if (!tool) {
      throw new NotFoundException(`Unknown tool: ${name}`);
    }
    return tool;
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Returns LLM-format tool definitions filtered by the agent kind. */
  getLlmDefinitionsForKind(kind: AiAgentKind): LlmToolDefinition[] {
    return [...this.tools.values()]
      .filter((t) => this.scope.get(t.name)?.has(kind) ?? false)
      .map(toLlmDefinition);
  }

  /** Returns LLM-format tool definitions for a specific subset, by name. */
  getLlmDefinitions(names: string[]): LlmToolDefinition[] {
    return names
      .filter((n) => this.tools.has(n))
      .map((n) => toLlmDefinition(this.tools.get(n)!));
  }

  /** Validates whether a tool can be used by an agent of the given kind. */
  isAllowedForKind(toolName: string, kind: AiAgentKind): boolean {
    return this.scope.get(toolName)?.has(kind) ?? false;
  }
}
