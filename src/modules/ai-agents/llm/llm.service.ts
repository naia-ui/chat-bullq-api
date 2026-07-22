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
import { SAKANA_DEFAULT_BASE_URL } from './llm.constants';

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
 * Cliente LLM normalizado para Sakana Fugu/Fugu Ultra (default) com suporte
 * adicional a Claude/Anthropic direto via API oficial (modelos `anthropic/*`
 * ou `claude-*`).
 *
 * Mantém o contrato público usado pelo runner, classifier, memória, RAG e
 * evals (`complete()`, `LlmMessage`, `LlmToolDefinition`) — o roteamento
 * entre providers acontece internamente, por prefixo do `modelId`.
 */
@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly client: OpenAI;
  private readonly hasApiKey: boolean;
  private readonly anthropicClient: Anthropic | null;
  private readonly hasAnthropicKey: boolean;
  private readonly openaiDirectClient: OpenAI | null;
  private readonly hasOpenAiDirectKey: boolean;

  constructor(config: ConfigService) {
    const apiKey = config.get<string>('SAKANA_API_KEY');
    const baseURL =
      config.get<string>('SAKANA_BASE_URL') ?? SAKANA_DEFAULT_BASE_URL;
    const timeout = Number(config.get<string>('SAKANA_TIMEOUT_MS') ?? 120_000);

    this.hasApiKey = !!apiKey;
    if (!apiKey) {
      this.logger.warn(
        'SAKANA_API_KEY not set — AI agents will fail at runtime',
      );
    }

    this.client = new OpenAI({
      apiKey: apiKey ?? 'missing',
      baseURL,
      timeout: Number.isFinite(timeout) && timeout > 0 ? timeout : 120_000,
    });

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

    // Reaproveita o mesmo SDK `openai` do client Sakana, mas sem baseURL
    // custom — vai pro endpoint oficial `api.openai.com`. GPT usa o mesmo
    // dialeto Chat Completions, então toda a conversão de mensagens/tools
    // já existente (toOpenAiMessages, toOpenAiTools, fromOpenAiMessage) é
    // reaproveitada como está.
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
    return this.completeSakana(req);
  }

  private isAnthropicModel(modelId: string): boolean {
    return modelId.startsWith('anthropic/') || modelId.startsWith('claude-');
  }

  private isOpenAiDirectModel(modelId: string): boolean {
    return modelId.startsWith('openai/') || modelId.startsWith('gpt-');
  }

  private async completeSakana(
    req: LlmCompletionRequest,
  ): Promise<LlmCompletionResponse> {
    if (!this.hasApiKey) {
      throw new InternalServerErrorException('SAKANA_API_KEY not set');
    }

    const modelId = this.normalizeModelId(req.modelId);
    const messages = this.toOpenAiMessages(req.messages);
    const tools = req.tools
      ? this.toOpenAiTools(this.sanitizeTools(req.tools))
      : undefined;

    let response: Awaited<
      ReturnType<OpenAI['chat']['completions']['create']>
    >;

    try {
      response = await this.client.chat.completions.create({
        model: modelId,
        messages: messages as any,
        max_tokens: req.maxTokens ?? 2048,
        temperature: req.temperature ?? 0.7,
        ...(tools && tools.length > 0 ? { tools: tools as any } : {}),
        // Prompt caching: prefixo estável (system + histórico) é reaproveitado
        // entre turnos da mesma conversa. Comprovado ~99% de cache hit no
        // segundo turno com prefixo idêntico. `prompt_cache_retention` mantém
        // o cache quente entre mensagens espaçadas do cliente.
        ...(req.cacheKey
          ? {
              prompt_cache_key: req.cacheKey,
              prompt_cache_retention: '24h',
            }
          : {}),
        ...(this.sanitizeModelParams(req.modelParams) as object),
      } as any);
    } catch (err: unknown) {
      this.handleSakanaError(err, modelId, tools, messages);

      // Rede de segurança: 400 com imagem no payload quase sempre é o
      // provider não conseguindo baixar/decodificar a URL (arquivo que
      // sumiu, host fora, formato recusado). Perder a visão de uma imagem
      // velha é infinitamente melhor que o agente não responder — refaz a
      // chamada UMA vez só com o texto.
      const stripped = this.stripImageParts(messages);
      if ((err as { status?: number })?.status === 400 && stripped) {
        this.logger.warn(
          `LLM 400 com imagem no payload — retry sem os image blocks [sakana/${modelId}]`,
        );
        try {
          response = await this.client.chat.completions.create({
            model: modelId,
            messages: stripped as any,
            max_tokens: req.maxTokens ?? 2048,
            temperature: req.temperature ?? 0.7,
            ...(tools && tools.length > 0 ? { tools: tools as any } : {}),
            ...(req.cacheKey
              ? { prompt_cache_key: req.cacheKey, prompt_cache_retention: '24h' }
              : {}),
            ...(this.sanitizeModelParams(req.modelParams) as object),
          } as any);
        } catch (retryErr: unknown) {
          throw new InternalServerErrorException(
            `LLM provider error: ${this.errorMessage(retryErr)}`,
          );
        }
      } else {
        throw new InternalServerErrorException(
          `LLM provider error: ${this.errorMessage(err)}`,
        );
      }
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
    const usage = this.extractUsage(response.usage as OpenAiUsage | undefined, modelId);

    return {
      message,
      stopReason,
      usage,
      rawModelId: response.model ?? modelId,
    };
  }

  // ─── OpenAI direto (modelId `openai/*` ou `gpt-*`) ─────────────────
  //
  // Mesmo dialeto Chat Completions do Sakana — só troca o client/endpoint.
  // Reaproveita toOpenAiMessages/toOpenAiTools/fromOpenAiMessage/
  // normalizeStopReason/sanitizeModelParams sem alteração.

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
   * A resposta da OpenAI não traz custo em USD pronto (igual ao Sakana
   * Fugu simples). Mantemos costUsd=0 em vez de inventar tabela de preço.
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
   * A Anthropic não expõe custo em USD na resposta (diferente de alguns
   * proxies OpenAI-compatible). Mantemos costUsd=0 em vez de inventar tabela
   * de preço — mesma política aplicada ao Sakana Fugu simples.
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

  // ─── conversão: nossos tipos → Sakana/OpenAI-compatible ───────────

  /**
   * Internamente salvamos modelos Sakana com prefixo `sakana/` para ficar
   * explícito no dashboard. A API recebe só o ID real do modelo.
   */
  private normalizeModelId(id: string): string {
    const trimmed = (id ?? '').trim();
    if (!trimmed) {
      throw new BadRequestException('modelId is required');
    }

    if (
      trimmed.startsWith('anthropic/') ||
      trimmed.startsWith('claude-') ||
      trimmed.startsWith('openai/') ||
      trimmed.startsWith('google/')
    ) {
      throw new BadRequestException(
        `Unsupported LLM model "${trimmed}". This deployment only uses Sakana models. ` +
          'Migrate agents to sakana/fugu-ultra-20260615 or sakana/fugu.',
      );
    }

    if (trimmed.startsWith('sakana/')) return trimmed.slice('sakana/'.length);
    if (trimmed === 'fugu' || trimmed.startsWith('fugu-')) return trimmed;

    throw new BadRequestException(
      `Unsupported Sakana model "${trimmed}". Use sakana/fugu or sakana/fugu-ultra-20260615.`,
    );
  }

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
   * compatibilidade com o PromptBuilder, mas não é enviado como `cache_control`
   * porque a API da Sakana é OpenAI-compatible.
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

  // ─── conversão: Sakana/OpenAI-compatible → nossos tipos ───────────

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

  private extractUsage(
    usage: OpenAiUsage | undefined,
    modelId: string,
  ): LlmUsage {
    const input = usage?.prompt_tokens ?? 0;
    const output = usage?.completion_tokens ?? 0;
    const cacheRead = usage?.prompt_tokens_details?.cached_tokens ?? 0;
    const explicitCost = this.findExplicitCost(usage);
    const costUsd =
      explicitCost ?? this.calculateCost(modelId, { input, output, cacheRead });

    if (modelId === 'fugu' && explicitCost == null) {
      this.logger.debug(
        'sakana_fugu_cost_unavailable — recording tokens with costUsd=0',
      );
    }

    return {
      inputTokens: input,
      outputTokens: output,
      cacheReadTokens: cacheRead,
      cacheWriteTokens: 0,
      costUsd,
    };
  }

  private findExplicitCost(usage: OpenAiUsage | undefined): number | null {
    if (!usage) return null;
    const candidates = [
      usage.cost,
      usage.cost_usd,
      usage.total_cost,
      usage.total_cost_usd,
    ];
    for (const c of candidates) {
      const n = typeof c === 'number' ? c : Number(c);
      if (Number.isFinite(n) && n >= 0) return n;
    }
    return null;
  }

  /**
   * Fugu Ultra tem preço fixo público. Fugu simples pode rotear modelos
   * diferentes; quando a API não retorna custo, mantemos 0 para não inventar.
   */
  private calculateCost(
    modelId: string,
    tokens: { input: number; output: number; cacheRead: number },
  ): number {
    if (modelId !== 'fugu-ultra-20260615' && modelId !== 'fugu-ultra') {
      return 0;
    }

    const uncachedInput = Math.max(0, tokens.input - tokens.cacheRead);
    const longContext = tokens.input > 272_000;
    const pricing = longContext
      ? { input: 10, output: 45, cacheRead: 1 }
      : { input: 5, output: 30, cacheRead: 0.5 };

    return (
      (uncachedInput * pricing.input +
        tokens.output * pricing.output +
        tokens.cacheRead * pricing.cacheRead) /
      1_000_000
    );
  }

  // ─── error handling ──────────────────────────────────────────────

  private handleSakanaError(
    err: unknown,
    modelId: string,
    tools: OpenAiTool[] | undefined,
    messages: OpenAiMessage[],
  ): void {
    const e = err as { status?: number; name?: string; message?: string };
    const status = e.status;
    const message = this.errorMessage(err);
    const toolNames = tools
      ?.map((t) => ((t.function as Record<string, unknown>)?.name as string) ?? '')
      .filter(Boolean)
      .join(',');
    this.logger.error(
      `LLM call failed [sakana/${modelId}] status=${status ?? '?'}: ${message} | tools=[${toolNames ?? ''}]`,
    );
    if (status === 400) {
      this.logger.debug(`Messages count: ${messages.length}`);
      const system = messages.find((m) => m.role === 'system');
      const sample = typeof system?.content === 'string'
        ? system.content.slice(0, 600)
        : '';
      if (sample) this.logger.debug(`System sample: ${sample}...`);
      if (tools) {
        this.logger.debug(
          `Tools dump: ${safeStringify(tools).slice(0, 4000)}`,
        );
      }
    }
  }

  /**
   * Devolve uma cópia das mensagens sem nenhum bloco `image_url` (cada um
   * vira um marcador textual), ou null quando não havia imagem nenhuma —
   * nesse caso o retry não faria diferença.
   */
  private stripImageParts(messages: OpenAiMessage[]): OpenAiMessage[] | null {
    let found = false;
    const out = messages.map((message) => {
      if (!Array.isArray(message.content)) return message;

      const parts = (message.content as Array<Record<string, unknown>>).map(
        (part) => {
          if (part?.type !== 'image_url') return part;
          found = true;
          return {
            type: 'text',
            text: '[imagem enviada — não foi possível carregar pra eu visualizar]',
          };
        },
      );

      const onlyText = parts.every((p) => p.type === 'text');
      return {
        ...message,
        content: onlyText
          ? parts.map((p) => String(p.text ?? '')).join('\n')
          : parts,
      } as OpenAiMessage;
    });

    return found ? out : null;
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
