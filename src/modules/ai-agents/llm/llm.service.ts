import {
  Injectable,
  Logger,
  InternalServerErrorException,
  BadRequestException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';

import {
  LlmCompletionRequest,
  LlmCompletionResponse,
  LlmContent,
  LlmContentPart,
  LlmMessage,
  LlmToolCall,
  LlmToolDefinition,
  LlmUsage,
} from './llm.types';
type OpenAiMessage = Record<string, unknown>;
type OpenAiTool = Record<string, unknown>;
type OpenAiUsage = {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  [key: string]: unknown;
};

type AnthropicContentBlock = Record<string, unknown>;
type AnthropicMessage = { role: 'user' | 'assistant'; content: AnthropicContentBlock[] };
type AnthropicTool = Record<string, unknown>;

/**
 * Cliente LLM normalizado com suporte a Claude/Anthropic (modelos
 * `anthropic/*` ou `claude-*`) e GPT/OpenAI (modelos `openai/*` ou `gpt-*`)
 * diretos via API oficial de cada provider.
 *
 * Mantém o contrato público usado pelo runner, classifier, memória, RAG e
 * evals (`complete()`, `LlmMessage`, `LlmToolDefinition`) — o roteamento
 * entre providers acontece internamente, por prefixo do `modelId`.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly anthropicClient: Anthropic | null;
  private readonly hasAnthropicKey: boolean;
  private readonly openaiDirectClient: OpenAI | null;
  private readonly hasOpenAiDirectKey: boolean;

  constructor(config: ConfigService) {
    const anthropicApiKey = config.get<string>('ANTHROPIC_API_KEY');
    this.hasAnthropicKey = !!anthropicApiKey;
    this.anthropicClient = anthropicApiKey
      ? new Anthropic({ apiKey: anthropicApiKey })
      : null;
    if (!anthropicApiKey) {
      this.logger.warn(
        'ANTHROPIC_API_KEY not set — Claude models will fail at runtime',
      );
    }

    // Client oficial `api.openai.com`. Todas as funções de conversão de
    // mensagens/tools (toOpenAiMessages, toOpenAiTools, fromOpenAiMessage)
    // usam o dialeto padrão Chat Completions da OpenAI.
    const openaiDirectApiKey = config.get<string>('OPENAI_API_KEY');
    this.hasOpenAiDirectKey = !!openaiDirectApiKey;
    this.openaiDirectClient = openaiDirectApiKey
      ? new OpenAI({ apiKey: openaiDirectApiKey })
      : null;
    if (!openaiDirectApiKey) {
      this.logger.warn(
        'OPENAI_API_KEY not set — GPT models will fail at runtime',
      );
    }
  }

  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const modelId = (req.modelId ?? '').trim();
    if (this.isAnthropicModel(modelId)) {
      return this.completeAnthropic(req, modelId);
    }
    if (this.isOpenAiDirectModel(modelId)) {
      return this.completeOpenAiDirect(req, modelId);
    }
    throw new BadRequestException(
      `Unsupported LLM model "${modelId}". Use anthropic/claude-* or openai/gpt-*.`,
    );
  }

  private isAnthropicModel(modelId: string): boolean {
    return modelId.startsWith('anthropic/') || modelId.startsWith('claude-');
  }

  private isOpenAiDirectModel(modelId: string): boolean {
    return modelId.startsWith('openai/') || modelId.startsWith('gpt-');
  }

  // ─── OpenAI direto (modelId `openai/*` ou `gpt-*`) ─────────────────

  private async completeOpenAiDirect(
    req: LlmCompletionRequest,
    rawModelId: string,
  ): Promise<LlmCompletionResponse> {
    if (!this.hasOpenAiDirectKey || !this.openaiDirectClient) {
      throw new InternalServerErrorException('OPENAI_API_KEY not set');
    }

    const modelId = this.normalizeOpenAiDirectModelId(rawModelId);
    const messages = this.toOpenAiMessages(req.messages);
    const tools = req.tools
      ? this.toOpenAiTools(this.sanitizeTools(req.tools))
      : undefined;

    let response: Awaited<
      ReturnType<OpenAI['chat']['completions']['create']>
    >;
    try {
      response = await this.openaiDirectClient.chat.completions.create({
        model: modelId,
        messages: messages as any,
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.7,
        ...(tools && tools.length > 0 ? { tools: tools as any } : {}),
        ...(this.sanitizeModelParams(req.modelParams) as object),
      } as any);
    } catch (err: unknown) {
      this.logger.error(
        `LLM call failed [openai/${modelId}]: ${this.errorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        `LLM provider error: ${this.errorMessage(err)}`,
      );
    }

    if ('tee' in response) {
      throw new InternalServerErrorException('LLM streaming response not supported');
    }

    const choice = response.choices?.[0];
    if (!choice?.message) {
      throw new InternalServerErrorException('LLM provider returned no message');
    }

    const message = this.fromOpenAiMessage(choice.message as any);
    const stopReason = this.normalizeStopReason(choice.finish_reason);
    const usage = this.extractOpenAiDirectUsage(
      response.usage as OpenAiUsage | undefined,
      modelId,
    );

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? modelId,
    };
  }

  /** Aceita `openai/gpt-...` ou `gpt-...` puro; API só quer o ID puro. */
  private normalizeOpenAiDirectModelId(id: string): string {
    const trimmed = id.startsWith('openai/') ? id.slice('openai/'.length) : id;
    if (!trimmed) {
      throw new BadRequestException(`Unsupported OpenAI model "${id}".`);
    }
    return trimmed;
  }

  /**
   * A resposta da OpenAI não traz custo em USD pronto. Mantemos costUsd=0
   * em vez de inventar tabela de preço.
   */
  private extractOpenAiDirectUsage(
    usage: OpenAiUsage | undefined,
    modelId: string,
  ): LlmUsage {
    const input = usage?.prompt_tokens ?? 0;
    const output = usage?.completion_tokens ?? 0;
    const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    this.logger.debug(
      `openai_direct_cost_unavailable — recording tokens with costUsd=0 [${modelId}]`,
    );

    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      costUsd: 0,
    };
  }

  // ─── Anthropic/Claude direto (modelId `anthropic/*` ou `claude-*`) ────

  private async completeAnthropic(
    req: LlmCompletionRequest,
    rawModelId: string,
  ): Promise<LlmCompletionResponse> {
    if (!this.hasAnthropicKey || !this.anthropicClient) {
      throw new InternalServerErrorException('ANTHROPIC_API_KEY not set');
    }

    const model = this.normalizeAnthropicModelId(rawModelId);
    const systemParts: string[] = [];
    const messages = this.toAnthropicMessages(req.messages, systemParts);
    const tools = req.tools
      ? this.toAnthropicTools(this.sanitizeTools(req.tools))
      : undefined;

    let response: Anthropic.Message;
    try {
      response = await this.anthropicClient.messages.create({
        model,
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.7,
        ...(systemParts.length > 0 ? { system: systemParts.join('\n\n') } : {}),
        messages: messages as any,
        ...(tools && tools.length > 0 ? { tools: tools as any } : {}),
        ...(this.sanitizeAnthropicModelParams(req.modelParams) as object),
      });
    } catch (err: unknown) {
      this.logger.error(
        `LLM call failed [anthropic/${model}]: ${this.errorMessage(err)}`,
      );
      throw new InternalServerErrorException(
        `LLM provider error: ${this.errorMessage(err)}`,
      );
    }

    const message = this.fromAnthropicMessage(response.content);
    const stopReason = this.normalizeAnthropicStopReason(response.stop_reason);
    const usage = this.extractAnthropicUsage(response.usage, model);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? model,
    };
  }

  /** Aceita `anthropic/claude-...` ou `claude-...` puro; API só quer o ID puro. */
  private normalizeAnthropicModelId(id: string): string {
    const trimmed = id.startsWith('anthropic/') ? id.slice('anthropic/'.length) : id;
    if (!trimmed.startsWith('claude-')) {
      throw new BadRequestException(`Unsupported Anthropic model "${id}".`);
    }
    return trimmed;
  }

  /**
   * Converte `LlmMessage[]` pro formato Anthropic Messages API: system vira
   * parâmetro à parte, e mensagens `tool` (role) viram content block
   * `tool_result` dentro de uma mensagem `user` — várias tool results
   * consecutivas são fundidas numa única mensagem `user`, como a API exige.
   */
  private toAnthropicMessages(
    input: LlmMessage[],
    systemParts: string[],
  ): AnthropicMessage[] {
    const out: AnthropicMessage[] = [];

    const pushBlocks = (role: 'user' | 'assistant', blocks: AnthropicContentBlock[]) => {
      if (blocks.length === 0) return;
      const last = out[out.length - 1];
      if (last && last.role === role) {
        last.content.push(...blocks);
        return;
      }
      out.push({ role, content: blocks });
    };

    for (const m of input) {
      if (m.role === 'system') {
        const text = this.textOnly(m.content);
        if (text) systemParts.push(text);
        continue;
      }

      if (m.role === 'tool') {
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        pushBlocks('user', [
          {
            type: 'tool_result',
            tool_use_id: m.toolCallId,
            content: this.textOnly(m.content) || '(empty)',
          },
        ]);
        continue;
      }

      if (m.role === 'user') {
        pushBlocks('user', this.toAnthropicContentBlocks(m.content));
        continue;
      }

      if (m.role === 'assistant') {
        const blocks: AnthropicContentBlock[] = [];
        const text = this.textOnly(m.content);
        if (text) blocks.push({ type: 'text', text });
        for (const tc of m.toolCalls ?? []) {
          blocks.push({
            type: 'tool_use',
            id: tc.id,
            name: tc.name,
            input: tc.arguments,
          });
        }
        pushBlocks('assistant', blocks);
      }
    }

    return out;
  }

  private toAnthropicContentBlocks(content: LlmContent): AnthropicContentBlock[] {
    if (typeof content === 'string') {
      return content.length > 0 ? [{ type: 'text', text: content }] : [];
    }

    const blocks: AnthropicContentBlock[] = [];
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text && part.text.length > 0) {
          blocks.push({ type: 'text', text: part.text });
        }
        continue;
      }
      if (part.type === 'image') {
        if (part.base64) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: part.base64.mediaType,
              data: part.base64.data,
            },
          });
        } else if (part.url) {
          blocks.push({
            type: 'image',
            source: { type: 'url', url: part.url },
          });
        }
      }
    }
    return blocks;
  }

  private toAnthropicTools(tools: LlmToolDefinition[]): AnthropicTool[] {
    return tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    }));
  }

  /** Passa apenas parâmetros que a Messages API da Anthropic aceita. */
  private sanitizeAnthropicModelParams(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!params) return {};
    const allowed = new Set(['top_p', 'top_k', 'stop_sequences', 'thinking', 'metadata']);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  private fromAnthropicMessage(content: Anthropic.ContentBlock[]): LlmMessage {
    let text = '';
    const toolCalls: LlmToolCall[] = [];
    for (const block of content ?? []) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({
          id: block.id,
          name: block.name,
          arguments: (block.input ?? {}) as Record<string, unknown>,
        });
      }
    }
    return {
      role: 'assistant',
      content: text,
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private normalizeAnthropicStopReason(
    reason: string | null | undefined,
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'end_turn':
      case 'stop_sequence':
        return 'stop';
      case 'tool_use':
        return 'tool_calls';
      case 'max_tokens':
        return 'length';
      case 'refusal':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  /**
   * A Anthropic não expõe custo em USD na resposta. Mantemos costUsd=0 em
   * vez de inventar tabela de preço — mesma política aplicada ao provider
   * OpenAI direto.
   */
  private extractAnthropicUsage(
    usage: Anthropic.Usage | undefined,
    modelId: string,
  ): LlmUsage {
    const input = usage?.input_tokens ?? 0;
    const output = usage?.output_tokens ?? 0;
    const cacheRead = usage?.cache_read_input_tokens ?? 0;
    const cacheWrite = usage?.cache_creation_input_tokens ?? 0;

    this.logger.debug(
      `anthropic_cost_unavailable — recording tokens with costUsd=0 [${modelId}]`,
    );

    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: cacheWrite,
      costUsd: 0,
    };
  }

  // ─── conversão: nossos tipos → dialeto OpenAI Chat Completions ────

  /**
   * Converte nosso array `LlmMessage[]` para o formato Chat Completions:
   * system/user/assistant/tool, com tool calls no padrão `function`.
   */
  private toOpenAiMessages(input: LlmMessage[]): OpenAiMessage[] {
    const out: OpenAiMessage[] = [];

    for (const m of input) {
      if (m.role === 'system') {
        const text = this.textOnly(m.content);
        if (!text) continue;
        out.push({ role: 'system', content: text });
        continue;
      }

      if (m.role === 'tool') {
        if (!m.toolCallId) {
          this.logger.warn('Tool message without toolCallId — dropping');
          continue;
        }
        out.push({
          role: 'tool',
          tool_call_id: m.toolCallId,
          name: m.name,
          content: this.textOnly(m.content) || '(empty)',
        });
        continue;
      }

      if (m.role === 'user') {
        const content = this.toOpenAiUserContent(m.content);
        if (this.isEmptyContent(content)) continue;
        out.push({ role: 'user', content });
        continue;
      }

      if (m.role === 'assistant') {
        const content = this.textOnly(m.content);
        const msg: OpenAiMessage = {
          role: 'assistant',
          content: content || null,
        };
        const toolCalls = (m.toolCalls ?? []).map((tc) => ({
          id: tc.id,
          type: 'function',
          function: {
            name: tc.name,
            arguments: safeStringify(tc.arguments),
          },
        }));
        if (toolCalls.length > 0) msg.tool_calls = toolCalls;
        if (!content && toolCalls.length === 0) continue;
        out.push(msg);
      }
    }

    return out;
  }

  private toOpenAiUserContent(content: LlmContent): unknown {
    if (typeof content === 'string') return content;

    const parts: Array<Record<string, unknown>> = [];
    for (const part of content) {
      if (part.type === 'text') {
        if (part.text && part.text.length > 0) {
          parts.push({ type: 'text', text: part.text });
        }
        continue;
      }

      if (part.type === 'image') {
        const url = this.imageUrl(part);
        if (url) {
          parts.push({ type: 'image_url', image_url: { url } });
        }
      }
    }

    if (parts.length === 0) return '';
    const onlyText = parts.every((p) => p.type === 'text');
    if (onlyText) return parts.map((p) => String(p.text ?? '')).join('\n');
    return parts;
  }

  private imageUrl(part: Extract<LlmContentPart, { type: 'image' }>): string | null {
    if (part.url) return part.url;
    if (part.base64) {
      return `data:${part.base64.mediaType};base64,${part.base64.data}`;
    }
    return null;
  }

  private isEmptyContent(content: unknown): boolean {
    if (typeof content === 'string') return content.length === 0;
    if (Array.isArray(content)) return content.length === 0;
    return content == null;
  }

  /**
   * Extrai texto de content parts. O marcador `cache` é mantido no tipo por
   * compatibilidade com o PromptBuilder, mas não é enviado como
   * `cache_control` no dialeto Chat Completions da OpenAI.
   */
  private textOnly(content: LlmContent): string {
    if (typeof content === 'string') return content;
    return content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');
  }

  /**
   * Filtra tools com schema obviamente quebrado antes de mandar pra API.
   */
  private sanitizeTools(tools: LlmToolDefinition[]): LlmToolDefinition[] {
    const valid: LlmToolDefinition[] = [];
    for (const t of tools) {
      const reason = this.validateToolSchema(t);
      if (reason) {
        this.logger.warn(
          `Dropping tool ${t.name} from LLM request: ${reason}`,
        );
        continue;
      }
      valid.push(t);
    }
    return valid;
  }

  private validateToolSchema(t: LlmToolDefinition): string | null {
    if (!t.name || typeof t.name !== 'string') return 'missing name';
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) {
      return `invalid name "${t.name}" — must match [a-zA-Z0-9_-]{1,64}`;
    }
    if (!t.description || typeof t.description !== 'string') {
      return 'missing description';
    }
    const p = t.parameters as Record<string, unknown> | undefined;
    if (!p || typeof p !== 'object') return 'parameters not an object';
    if (p.type !== 'object') {
      return `parameters.type must be "object", got ${JSON.stringify(p.type)}`;
    }
    if (p.properties && typeof p.properties !== 'object') {
      return 'parameters.properties must be an object';
    }
    return null;
  }

  private toOpenAiTools(tools: LlmToolDefinition[]): OpenAiTool[] {
    return tools.map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  /**
   * Passa apenas parâmetros compatíveis com Chat Completions. Campos antigos
   * de Anthropic (`top_k`, `thinking`, etc.) são ignorados sem quebrar runs.
   */
  private sanitizeModelParams(
    params: Record<string, unknown> | undefined,
  ): Record<string, unknown> {
    if (!params) return {};
    const allowed = new Set([
      'top_p',
      'frequency_penalty',
      'presence_penalty',
      'seed',
      'stop',
      'response_format',
      'tool_choice',
      'parallel_tool_calls',
      'metadata',
      'service_tier',
      'prompt_cache_key',
      'prompt_cache_retention',
      'reasoning_effort',
      'verbosity',
    ]);
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(params)) {
      if (k === 'stop_sequences' && v !== undefined) {
        out.stop = v;
        continue;
      }
      if (allowed.has(k)) out[k] = v;
    }
    return out;
  }

  // ─── conversão: dialeto OpenAI Chat Completions → nossos tipos ────

  private fromOpenAiMessage(message: {
    content?: string | null;
    tool_calls?: Array<{
      id?: string;
      type?: string;
      function?: { name?: string; arguments?: string };
      custom?: { name?: string; input?: string };
    }>;
  }): LlmMessage {
    const toolCalls: LlmToolCall[] = [];

    for (const call of message.tool_calls ?? []) {
      const fn = call.function ?? call.custom;
      const name = fn?.name;
      if (!name) continue;
      toolCalls.push({
        id: call.id ?? `tool_${toolCalls.length + 1}`,
        name,
        arguments: this.parseToolArguments(
          'arguments' in (fn as object) ? (fn as { arguments?: string }).arguments : (fn as { input?: string }).input,
          name,
        ),
      });
    }

    return {
      role: 'assistant',
      content: message.content ?? '',
      ...(toolCalls.length > 0 ? { toolCalls } : {}),
    };
  }

  private parseToolArguments(
    raw: string | undefined,
    toolName: string,
  ): Record<string, unknown> {
    if (!raw || raw.trim().length === 0) return {};
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
      this.logger.warn(
        `Tool ${toolName} returned non-object arguments — using empty object`,
      );
      return {};
    } catch {
      this.logger.warn(
        `Tool ${toolName} returned malformed JSON arguments: ${raw.slice(0, 300)}`,
      );
      return {};
    }
  }

  private normalizeStopReason(
    reason: string | null | undefined,
  ): LlmCompletionResponse['stopReason'] {
    switch (reason) {
      case 'stop':
        return 'stop';
      case 'tool_calls':
      case 'function_call':
        return 'tool_calls';
      case 'length':
        return 'length';
      case 'content_filter':
        return 'content_filter';
      default:
        return 'other';
    }
  }

  private errorMessage(err: unknown): string {
    if (err instanceof Error) return err.message;
    return String(err);
  }
}

function safeStringify(input: unknown): string {
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(input, (_key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    });
  } catch (err) {
    return `[unstringifyable: ${(err as Error)?.message}]`;
  }
}
