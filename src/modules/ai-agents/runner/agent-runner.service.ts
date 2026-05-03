import { Injectable, Logger } from '@nestjs/common';
import {
  AiFinalAction,
  AiRunStatus,
  Conversation,
  Message,
  AiSkill,
  AiTool,
  NotificationType,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { LlmService } from '../llm/llm.service';
import { LlmMessage, LlmToolCall, LlmToolDefinition } from '../llm/llm.types';
import { ToolRegistry } from '../tools/tool-registry.service';
import { ToolContext } from '../tools/tool.types';
import { HttpToolExecutorService } from '../tools/http-tool-executor.service';
import { SqlToolExecutorService } from '../tools/sql-tool-executor.service';
import { PromptBuilderService } from './prompt-builder.service';
import { CatalogSyncService } from './catalog-sync.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { isToolCallFailure } from '../agents/agents.service';

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
    private readonly sqlExecutor: SqlToolExecutorService,
    private readonly catalogSync: CatalogSyncService,
    private readonly notifications: NotificationsService,
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

    const [organization, channel, contact, recentMessages, memory, catalog] =
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
        // Compact product list for the cacheable system prompt block.
        // Source of truth: Trivapp /api/v1/catalog (5min in-memory cache).
        // Skill getProductPitch(slug) fetches full details on demand.
        this.catalogSync.getCompactCatalog(conversation.organizationId),
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
    const { llmTools, customSkillsByName, skillInstructions } =
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
      catalog,
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
          // (transferred / closed / delegated) or a reply was already sent.
          const rawText = this.extractText(response.message.content);
          const text = sanitizeAssistantText(rawText);
          if (rawText && rawText !== text) {
            this.logger.warn(
              `Run ${run.id}: stripped turn markers from fallback text (raw="${rawText.slice(0, 80)}" → clean="${text.slice(0, 80)}")`,
            );
          }
          // Bail out if the model only emitted turn markers (e.g. "Human:")
          // or a stub too short to be a real reply. Sending such text would
          // look like the agent literally typing "Human: oi" to the user.
          const tooShortForReal = text.length < 4;
          if (text && !tooShortForReal && finalAction === AiFinalAction.NO_ACTION) {
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
          } else if (rawText && (tooShortForReal || !text)) {
            this.logger.warn(
              `Run ${run.id}: skipping fallback — sanitized text was empty or too short ("${rawText.slice(0, 80)}")`,
            );
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
          customSkillsByName,
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
    customSkillsByName: Map<string, AiSkill & { tool: AiTool | null }>,
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

      // Run + auto-retry on transient failures only. We retry once with a
      // short backoff when the error looks transient (network, timeout,
      // 5xx upstream). 4xx and logic errors aren't retried because they
      // won't fix themselves — better to let the LLM see the error and
      // decide (transferToHuman, etc).
      let attempts = 0;
      const maxAttempts = 2;
      while (attempts < maxAttempts) {
        attempts++;
        errorMessage = undefined;
        try {
          const customSkill = customSkillsByName.get(call.name);
          if (customSkill && customSkill.tool) {
            const result =
              customSkill.source === 'SQL'
                ? await this.sqlExecutor.execute(
                    customSkill,
                    customSkill.tool,
                    call.arguments,
                    ctx,
                  )
                : await this.httpExecutor.execute(
                    customSkill,
                    customSkill.tool,
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
            `Tool ${call.name} failed (attempt ${attempts}/${maxAttempts}): ${errorMessage}`,
          );
        }

        // Decide retry. If the call succeeded logically, exit the loop.
        // For failures, retry only when transient — don't punish the user
        // with a slower response for a 404 that won't recover.
        const failed =
          !!errorMessage ||
          isToolCallFailure({ error: errorMessage ?? null, output });
        if (!failed) break;
        if (attempts >= maxAttempts) break;
        if (!isTransientFailure(errorMessage, output)) break;
        await new Promise((r) => setTimeout(r, 500));
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

      // Surface silent failures: notify the org's humans whenever a tool
      // call returns ok:false / status>=400 OR an exception was thrown.
      // Without this, the Lívia case happens — IA transfers and nobody sees.
      if (isToolCallFailure({ error: errorMessage ?? null, output })) {
        this.notifyToolFailure({
          ctx,
          toolName: call.name,
          input: call.arguments,
          output,
          errorMessage,
        }).catch((e) =>
          this.logger.warn(
            `Failed to dispatch tool-failure notification: ${e?.message ?? e}`,
          ),
        );
      }

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
   * Notifies every member of the org that a skill produced a failure.
   * Background dispatch — a notification miss shouldn't break the run.
   * Body summarizes the skill, the conversation, and the error so the
   * human can act without digging into the runs feed first.
   */
  private async notifyToolFailure(args: {
    ctx: ToolContext;
    toolName: string;
    input: unknown;
    output: unknown;
    errorMessage?: string;
  }) {
    const { ctx, toolName, input, output, errorMessage } = args;
    const summary =
      errorMessage ??
      this.summarizeFailureOutput(output) ??
      'Erro desconhecido na skill';

    await this.notifications.notifyOrgAgents({
      organizationId: ctx.organizationId,
      type: NotificationType.AI_TOOL_FAILURE,
      title: `Skill ${toolName} falhou`,
      body: `Conversa atendida pela IA teve falha em ${toolName}: ${summary}`,
      data: {
        runId: ctx.runId,
        agentId: ctx.agentId,
        conversationId: ctx.conversationId,
        toolName,
        input,
        output,
        errorMessage: errorMessage ?? null,
      },
    });
  }

  /** Pulls a human-readable error string from the executor's output JSON. */
  private summarizeFailureOutput(output: unknown): string | null {
    if (!output || typeof output !== 'object') return null;
    const o = output as Record<string, any>;
    if (typeof o.error === 'string') return o.error;
    const body = o.body;
    if (body && typeof body === 'object') {
      if (typeof body.message === 'string') return body.message;
      if (typeof body.error === 'string') return body.error;
    }
    if (Number.isFinite(Number(o.status))) return `HTTP ${o.status}`;
    return null;
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
    customSkillsByName: Map<string, AiSkill & { tool: AiTool | null }>;
    skillInstructions: string[];
  }> {
    const skillLinks = await this.prisma.aiAgentSkill.findMany({
      where: { agentId },
      include: { skill: { include: { tool: true } } },
    });

    const skillInstructions: string[] = [];
    const customSkillsByName = new Map<
      string,
      AiSkill & { tool: AiTool | null }
    >();

    for (const link of skillLinks) {
      const skill = link.skill;
      if (!skill.isActive || skill.deletedAt) continue;
      if (skill.promptInstructions) {
        skillInstructions.push(skill.promptInstructions.trim());
      }
      if (skill.source === 'BUILTIN') {
        // Built-in skills are always available via registry — no need to
        // expose again. We respect the attachment as user intent though
        // (could be used later for auditing).
        continue;
      }
      if (skill.tool) {
        customSkillsByName.set(skill.name, skill);
      } else {
        this.logger.warn(
          `Skill ${skill.name} (${skill.source}) has no bound tool — skipping`,
        );
      }
    }

    // Built-in defaults — always available based on agent kind.
    const defaultLlm = this.registry.getLlmDefinitionsForKind(kind);

    const seen = new Set<string>();
    const llmTools: LlmToolDefinition[] = [];
    for (const t of defaultLlm) {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        llmTools.push(t);
      }
    }
    for (const [name, skill] of customSkillsByName) {
      if (!seen.has(name)) {
        seen.add(name);
        llmTools.push({
          name,
          description: skill.description,
          parameters: skill.parameters as Record<string, unknown>,
        });
      }
    }

    return { llmTools, customSkillsByName, skillInstructions };
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

/**
 * Removes hallucinated turn markers from LLM text output. Models occasionally
 * emit transcripts like "Human: oi" or "Assistant: ..." when the few-shot
 * examples in the system prompt include similar formatting. Without this
 * scrubbing, the fallback reply path sends those markers verbatim to the
 * customer (real incident: agent replied literally "Human: oi" via WhatsApp).
 *
 * Strategy: strip a leading marker plus any further "Role: ..." lines that
 * should never reach the user. Returns trimmed text, or empty if everything
 * was a marker (which the caller treats as "don't send anything").
 */
function sanitizeAssistantText(input: string): string {
  if (!input) return '';
  let text = input.trim();
  const markerLine =
    /^\s*(human|user|assistant|ai|claude|model|lead|cliente|cliente:?|agent|você|voce|bot)\s*:\s*/i;

  // Repeatedly strip leading turn markers, since hallucinations sometimes
  // cascade ("Human: oi\nAssistant: ...").
  while (markerLine.test(text)) {
    text = text.replace(markerLine, '').trim();
  }

  // If the body still contains a "Role:" mid-text on its own line (e.g.
  // model echoed "Lead: comprou X"), drop everything from that line down.
  const splitIdx = text.search(/\n\s*(human|user|assistant|ai|claude|lead|cliente)\s*:\s*/i);
  if (splitIdx >= 0) text = text.slice(0, splitIdx).trim();

  return text;
}

/**
 * Tells whether a tool failure is worth retrying. Transient = upstream
 * blip the second attempt might dodge: connection drops, timeouts,
 * 5xx HTTP responses. Definitive failures (4xx, validation, missing
 * resource) won't recover so we bail immediately and let the agent
 * react.
 */
function isTransientFailure(
  errorMessage: string | undefined,
  output: unknown,
): boolean {
  // Exception thrown — check message for known transient signatures.
  if (errorMessage) {
    const m = errorMessage.toLowerCase();
    if (
      m.includes('timeout') ||
      m.includes('econnreset') ||
      m.includes('econnrefused') ||
      m.includes('etimedout') ||
      m.includes('socket hang up') ||
      m.includes('network') ||
      m.includes('fetch failed')
    ) {
      return true;
    }
    // status 5xx baked into the message
    if (/\b(50\d|429)\b/.test(m)) return true;
    return false;
  }
  // Logical failure — retry only if status is 5xx or 429.
  if (output && typeof output === 'object') {
    const status = Number((output as any).status);
    if (Number.isFinite(status) && (status >= 500 || status === 429)) {
      return true;
    }
  }
  return false;
}
