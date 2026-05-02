import { Injectable, Logger } from '@nestjs/common';
import {
  AiFinalAction,
  AiRunStatus,
  Conversation,
  Message,
  AiTool as AiToolRow,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmToolCall, LlmToolDefinition } from '../llm/llm.types';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ToolContext } from '../tools/tool.types';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import { PromptBuilderService } from './prompt-builder.service';

const MAX_TOOL_ITERATIONS = 8;
const MAX_RECENT_MESSAGES = 30;

interface RunInput {
  conversation: Conversation;
  triggerMessage: Message;
  /**
   * Internal: how many auto-chained runs already happened in this turn.
   * Bounded to avoid infinite recursion when an agent delegates back and
   * forth. Set automatically on chained calls, callers shouldn't pass this.
   */
  chainDepth?: number;
}

const MAX_CHAIN_DEPTH = 3;

@Injectable()
export class AiAgentRunnerService {
  private readonly logger = new Logger(AiAgentRunnerService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly llm: LlmService,
    private readonly registry: ToolRegistry,
    private readonly promptBuilder: PromptBuilderService,
    private readonly httpExecutor: HttpToolExecutorService,
  ) {}

  async run({
    conversation,
    triggerMessage,
    chainDepth = 0,
  }: RunInput): Promise<void> {
    const agent = await this.resolveAgent(conversation);
    if (!agent) {
      this.logger.debug(
        `No agent resolved for conv ${conversation.id} — skipping run`,
      );
      return;
    }

    const [organization, channel, contact, recentMessages, memory] =
      await Promise.all([
        this.prisma.organization.findUniqueOrThrow({
          where: { id: conversation.organizationId },
        }),
        this.prisma.channel.findUniqueOrThrow({
          where: { id: conversation.channelId },
        }),
        this.prisma.contact.findUniqueOrThrow({
          where: { id: conversation.contactId },
        }),
        this.prisma.message.findMany({
          where: { conversationId: conversation.id },
          orderBy: { createdAt: 'desc' },
          take: MAX_RECENT_MESSAGES,
        }),
        this.prisma.aiAgentMemory.findUnique({
          where: {
            agentId_contactId: {
              agentId: agent.id,
              contactId: conversation.contactId,
            },
          },
        }),
      ]);

    const run = await this.prisma.aiAgentRun.create({
      data: {
        organizationId: conversation.organizationId,
        conversationId: conversation.id,
        agentId: agent.id,
        triggerMessageId: triggerMessage.id,
        modelId: agent.modelId,
        status: AiRunStatus.RUNNING,
      },
    });

    // Resolve every tool the agent can call:
    //   1. built-in defaults filtered by kind (reply/transfer/tag/...);
    //   2. tools attached via skills (each skill.tools[]);
    //   3. tools attached directly to the agent (agent.extraTools).
    // Custom HTTP tools live in the DB; we keep their rows here so the
    // runner can hand them to HttpToolExecutor on tool-call time.
    const { llmTools, customToolsByName, skillInstructions } =
      await this.resolveToolsAndSkills(agent.id, agent.kind);

    const startedAt = Date.now();
    const messages = this.promptBuilder.buildMessages({
      organization,
      agent,
      channel,
      contact,
      conversation,
      // Reverse to chronological order for the LLM.
      recentMessages: recentMessages.reverse(),
      memorySummary: memory?.summary ?? null,
      memoryFacts: (memory?.facts as Record<string, unknown>) ?? null,
      triggerMessage,
      skillInstructions,
    });

    const tools = llmTools;

    const aggregateUsage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0,
    };

    let finalAction: AiFinalAction = AiFinalAction.NO_ACTION;
    let iterationCount = 0;

    try {
      // Mark this agent as the active one on the conversation.
      await this.prisma.conversation.update({
        where: { id: conversation.id },
        data: { activeAgentId: agent.id },
      });

      while (iterationCount < MAX_TOOL_ITERATIONS) {
        iterationCount++;

        const response = await this.llm.complete({
          modelId: agent.modelId,
          messages,
          tools,
          temperature: agent.temperature,
          maxTokens: agent.maxTokens,
          modelParams: (agent.modelParams as Record<string, unknown>) ?? undefined,
        });

        aggregateUsage.inputTokens += response.usage.inputTokens;
        aggregateUsage.outputTokens += response.usage.outputTokens;
        aggregateUsage.cacheReadTokens += response.usage.cacheReadTokens;
        aggregateUsage.cacheWriteTokens += response.usage.cacheWriteTokens;
        aggregateUsage.costUsd += response.usage.costUsd;

        if (response.stopReason === 'stop' || !response.message.toolCalls?.length) {
          // Model ended its turn without further tool calls. Some models
          // (especially after a tool result) emit the response as plain
          // assistant text instead of using replyToConversation explicitly.
          // Auto-send that text as a reply so we don't drop work the model
          // already paid for. Skip if a final action already happened
          // (transferred / closed / delegated) — in those cases the model
          // is just chatting to itself and shouldn't echo to the customer.
          const text = this.extractText(response.message.content);
          if (text && finalAction === AiFinalAction.NO_ACTION) {
            this.logger.log(
              `Run ${run.id}: model emitted text without replyToConversation, auto-sending as fallback`,
            );
            try {
              const replyTool = this.registry.get('replyToConversation');
              const result = await replyTool.execute(
                { text },
                {
                  organizationId: conversation.organizationId,
                  conversationId: conversation.id,
                  contactId: conversation.contactId,
                  channelId: conversation.channelId,
                  agentId: agent.id,
                  runId: run.id,
                  triggerMessageId: triggerMessage.id,
                },
              );
              if (result.finalAction) {
                finalAction = result.finalAction as AiFinalAction;
              }
            } catch (err: any) {
              this.logger.error(
                `Run ${run.id}: fallback reply failed: ${err?.message ?? err}`,
              );
            }
          }
          break;
        }

        // Append the assistant's tool-calling turn so the model has it in
        // context when we feed back the tool results.
        messages.push(response.message);

        const toolResults = await this.executeToolCalls(
          response.message.toolCalls,
          {
            organizationId: conversation.organizationId,
            conversationId: conversation.id,
            contactId: conversation.contactId,
            channelId: conversation.channelId,
            agentId: agent.id,
            runId: run.id,
            triggerMessageId: triggerMessage.id,
          },
          customToolsByName,
        );

        for (const result of toolResults) {
          messages.push({
            role: 'tool',
            toolCallId: result.toolCallId,
            name: result.toolName,
            content: JSON.stringify(result.output),
          });
          if (result.finalAction && finalAction === AiFinalAction.NO_ACTION) {
            finalAction = result.finalAction as AiFinalAction;
          }
        }

        // Hard short-circuit: handing off / closing the conversation should
        // stop the loop even if the model would have wanted another turn.
        if (
          finalAction === AiFinalAction.TRANSFERRED_TO_HUMAN ||
          finalAction === AiFinalAction.CLOSED_CONVERSATION
        ) {
          break;
        }
      }

      await this.prisma.aiAgentRun.update({
        where: { id: run.id },
        data: {
          status: AiRunStatus.COMPLETED,
          finalAction,
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          inputTokens: aggregateUsage.inputTokens,
          outputTokens: aggregateUsage.outputTokens,
          cacheReadTokens: aggregateUsage.cacheReadTokens,
          cacheWriteTokens: aggregateUsage.cacheWriteTokens,
          costUsd: aggregateUsage.costUsd,
        },
      });

      // Auto-chain: if this run delegated to a worker, immediately fire the
      // worker run so the customer gets the new agent's first message right
      // away — no need to wait for them to send something. The worker reads
      // the full history (including the orchestrator's "vou te passar pra X")
      // and starts speaking. Bounded by MAX_CHAIN_DEPTH to avoid recursion.
      if (
        finalAction === AiFinalAction.DELEGATED &&
        chainDepth < MAX_CHAIN_DEPTH
      ) {
        const refreshed = await this.prisma.conversation.findUnique({
          where: { id: conversation.id },
        });
        if (refreshed && refreshed.activeAgentId && refreshed.activeAgentId !== agent.id) {
          this.logger.log(
            `Auto-chaining run for new active agent ${refreshed.activeAgentId} on conv ${conversation.id} (depth ${chainDepth + 1})`,
          );
          // Fire-and-forget — don't block the caller. The worker runs
          // asynchronously and emits its messages via realtime as usual.
          this.run({
            conversation: refreshed,
            triggerMessage,
            chainDepth: chainDepth + 1,
          }).catch((err) =>
            this.logger.error(
              `Auto-chain run failed for conv ${conversation.id}: ${err?.message ?? err}`,
            ),
          );
        }
      }
    } catch (err: any) {
      this.logger.error(
        `Agent run ${run.id} failed: ${err?.message ?? err}`,
        err?.stack,
      );
      await this.prisma.aiAgentRun.update({
        where: { id: run.id },
        data: {
          status: AiRunStatus.FAILED,
          errorMessage: err?.message ?? String(err),
          finishedAt: new Date(),
          durationMs: Date.now() - startedAt,
          inputTokens: aggregateUsage.inputTokens,
          outputTokens: aggregateUsage.outputTokens,
          cacheReadTokens: aggregateUsage.cacheReadTokens,
          cacheWriteTokens: aggregateUsage.cacheWriteTokens,
          costUsd: aggregateUsage.costUsd,
        },
      });
    }
  }

  private async resolveAgent(conversation: Conversation) {
    if (conversation.activeAgentId) {
      const active = await this.prisma.aiAgent.findFirst({
        where: { id: conversation.activeAgentId, isActive: true, deletedAt: null },
      });
      if (active) return active;
    }
    const channelLink = await this.prisma.aiAgentChannel.findFirst({
      where: {
        channelId: conversation.channelId,
        mode: 'AUTONOMOUS',
        agent: { isActive: true, deletedAt: null },
      },
      include: { agent: true },
      orderBy: { createdAt: 'asc' },
    });
    return channelLink?.agent ?? null;
  }

  private async executeToolCalls(
    calls: LlmToolCall[],
    ctx: ToolContext,
    customToolsByName: Map<string, AiToolRow>,
  ): Promise<
    Array<{
      toolCallId: string;
      toolName: string;
      output: unknown;
      finalAction?: string;
    }>
  > {
    const results: Array<{
      toolCallId: string;
      toolName: string;
      output: unknown;
      finalAction?: string;
    }> = [];

    for (const call of calls) {
      const startedAt = Date.now();
      let output: unknown;
      let errorMessage: string | undefined;
      let finalAction: string | undefined;

      try {
        const customTool = customToolsByName.get(call.name);
        if (customTool) {
          // Custom HTTP tool — executor handles fetch + response mapping.
          const result = await this.httpExecutor.execute(
            customTool,
            call.arguments,
            ctx,
          );
          output = result.output;
          finalAction = result.finalAction;
        } else if (this.registry.has(call.name)) {
          // Built-in.
          const tool = this.registry.get(call.name);
          const result = await tool.execute(call.arguments, ctx);
          output = result.output;
          finalAction = result.finalAction;
        } else {
          throw new Error(`Unknown tool: ${call.name}`);
        }
      } catch (err: any) {
        errorMessage = err?.message ?? String(err);
        output = { ok: false, error: errorMessage };
        this.logger.error(
          `Tool ${call.name} failed: ${errorMessage}`,
        );
      }

      await this.prisma.aiToolCall.create({
        data: {
          runId: ctx.runId,
          toolName: call.name,
          input: call.arguments as object,
          output: output as object,
          error: errorMessage,
          durationMs: Date.now() - startedAt,
        },
      });

      results.push({
        toolCallId: call.id,
        toolName: call.name,
        output,
        finalAction,
      });
    }

    return results;
  }

  /**
   * Computes the full tool catalog for an agent run:
   *   - kind-scoped built-in defaults from the in-memory registry
   *   - tools attached via skills (with their prompt instructions)
   *   - tools attached directly to the agent (no skill)
   *
   * Returns:
   *   llmTools           — tool defs to send to the LLM (deduped by name)
   *   customToolsByName  — DB rows for HTTP tools, used by the executor
   *   skillInstructions  — prompt fragments to append to system message
   */
  private async resolveToolsAndSkills(
    agentId: string,
    kind: 'ORCHESTRATOR' | 'WORKER',
  ): Promise<{
    llmTools: LlmToolDefinition[];
    customToolsByName: Map<string, AiToolRow>;
    skillInstructions: string[];
  }> {
    const [skillLinks, agentToolLinks] = await Promise.all([
      this.prisma.aiAgentSkill.findMany({
        where: { agentId },
        include: {
          skill: {
            include: {
              tools: { include: { tool: true } },
            },
          },
        },
      }),
      this.prisma.aiAgentTool.findMany({
        where: { agentId },
        include: { tool: true },
      }),
    ]);

    const skillInstructions: string[] = [];
    const customToolsByName = new Map<string, AiToolRow>();
    const builtInNames = new Set<string>();

    const collect = (tool: AiToolRow) => {
      if (!tool.isActive || tool.deletedAt) return;
      if (tool.source === 'CUSTOM_HTTP') {
        customToolsByName.set(tool.name, tool);
      } else if (tool.source === 'BUILTIN') {
        // Validate that the registry actually has it AND it's allowed for
        // this agent kind. This way an admin can't expose handBackToOrchestrator
        // to an orchestrator just by attaching it via UI.
        if (
          this.registry.has(tool.name) &&
          this.registry.isAllowedForKind(tool.name, kind)
        ) {
          builtInNames.add(tool.name);
        }
      }
    };

    for (const link of skillLinks) {
      const skill = link.skill;
      if (!skill.isActive || skill.deletedAt) continue;
      if (skill.promptInstructions) {
        skillInstructions.push(skill.promptInstructions.trim());
      }
      for (const t of skill.tools) collect(t.tool);
    }
    for (const link of agentToolLinks) collect(link.tool);

    // Always include the kind-scoped defaults (reply/transfer/tag/etc) so the
    // agent has the bare minimum to act, even if the admin forgot to attach.
    const defaultLlm = this.registry.getLlmDefinitionsForKind(kind);

    // Build dedup'd LLM tool defs. Custom HTTP tool has priority on name
    // collision (BUILTIN names like "replyToConversation" can't be shadowed
    // because they're filtered earlier).
    const seen = new Set<string>();
    const llmTools: LlmToolDefinition[] = [];
    for (const t of defaultLlm) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        llmTools.push(t);
      }
    }
    for (const name of builtInNames) {
      if (!seen.has(name)) {
        seen.add(name);
        const llmDef = this.registry.getLlmDefinitions([name])[0];
        if (llmDef) llmTools.push(llmDef);
      }
    }
    for (const [name, t] of customToolsByName) {
      if (!seen.has(name)) {
        seen.add(name);
        llmTools.push({
          name,
          description: t.description,
          parameters: t.parameters as Record<string, unknown>,
        });
      }
    }

    return { llmTools, customToolsByName, skillInstructions };
  }

  /**
   * Extract plain text from an LlmMessage content. Handles both string
   * content and content blocks (the cache_control format).
   */
  private extractText(content: unknown): string {
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return content
        .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
        .join('')
        .trim();
    }
    return '';
  }
}

interface LlmMessageWithToolCalls extends LlmMessage {
  toolCalls?: LlmToolCall[];
}
