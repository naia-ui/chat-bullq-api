import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiTool } from '@prisma/client';
import { ToolContext, ToolResult } from './tool.types';

/**
 * Executes user-defined HTTP tools. The user describes the call via templates;
 * this service substitutes runtime values, fires the request, then maps the
 * response back into a result the LLM can use.
 *
 * Templates use a tiny Mustache-ish dialect with three scopes:
 *   {{input.field}}   — value from the LLM's tool-call arguments
 *   {{ctx.field}}     — runtime context (organizationId, conversationId, etc)
 *   {{env.NAME}}      — process env, e.g. {{env.MEMBERS_API_KEY}}
 *
 * Response mapping uses naive JSONPath ($.foo.bar). Empty mapping returns the
 * raw response body so the LLM sees everything.
 */
@Injectable()
export class HttpToolExecutorService {
  private readonly logger = new Logger(HttpToolExecutorService.name);

  constructor(private readonly config: ConfigService) {}

  async execute(
    tool: AiTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (tool.source !== 'CUSTOM_HTTP') {
      throw new Error(`Tool ${tool.name} is not an HTTP tool`);
    }
    if (!tool.httpUrl || !tool.httpMethod) {
      return {
        output: { ok: false, error: 'Tool not fully configured (httpUrl/httpMethod missing)' },
      };
    }

    const url = this.renderTemplate(tool.httpUrl, { input, ctx });
    const method = tool.httpMethod.toUpperCase();
    const headers = this.renderHeaders(tool.httpHeaders, { input, ctx });

    let body: string | undefined;
    if (tool.httpBodyTemplate && method !== 'GET' && method !== 'DELETE') {
      body = this.renderTemplate(tool.httpBodyTemplate, { input, ctx });
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), tool.timeoutMs ?? 15000);

    try {
      this.logger.log(
        `[${tool.name}] ${method} ${url} (timeout=${tool.timeoutMs}ms)`,
      );
      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal,
      });

      const text = await response.text();
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // not JSON, keep as string
      }

      const durationMs = Date.now() - startedAt;
      const ok = response.ok;

      const mapped = this.mapResponse(tool.responseMap, {
        body: parsed,
        status: response.status,
        ok,
      });

      this.logger.log(
        `[${tool.name}] ${response.status} in ${durationMs}ms ok=${ok}`,
      );

      // If user provided a responseMap we use it, else expose status + body.
      const output =
        mapped !== undefined
          ? mapped
          : { ok, status: response.status, body: parsed };

      return { output };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      const message = isTimeout
        ? `Tool ${tool.name} timed out after ${tool.timeoutMs}ms`
        : err?.message ?? String(err);
      this.logger.error(`[${tool.name}] failed: ${message}`);
      return {
        output: { ok: false, error: message, timeout: isTimeout },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ── private helpers ─────────────────────────────────────────────

  private renderHeaders(
    raw: unknown,
    scopes: { input: Record<string, unknown>; ctx: ToolContext },
  ): Record<string, string> {
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      out[key] = this.renderTemplate(String(value ?? ''), scopes);
    }
    return out;
  }

  /**
   * Substitutes {{input.x}}, {{ctx.x}} and {{env.X}} occurrences. Unknown
   * variables become empty string — log a warning so the user can fix.
   */
  private renderTemplate(
    template: string,
    scopes: { input: Record<string, unknown>; ctx: ToolContext },
  ): string {
    return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_match, expr) => {
      const [scope, ...rest] = String(expr).split('.');
      const path = rest.join('.');
      let source: Record<string, unknown> | undefined;
      if (scope === 'input') source = scopes.input;
      else if (scope === 'ctx') source = scopes.ctx as unknown as Record<string, unknown>;
      else if (scope === 'env') {
        const v = this.config.get<string>(path);
        if (v === undefined) {
          this.logger.warn(`Template references unknown env: ${path}`);
          return '';
        }
        return v;
      }
      if (!source) {
        this.logger.warn(`Unknown template scope: ${scope}`);
        return '';
      }
      const value = this.lookup(source, path);
      if (value === undefined || value === null) {
        this.logger.warn(`Unknown template path: ${expr}`);
        return '';
      }
      return typeof value === 'string' ? value : JSON.stringify(value);
    });
  }

  /**
   * Applies a JSONPath-lite mapping: { ok: "$.success", message: "$.data.message" }.
   * Returns undefined when no mapping is provided (caller falls back to raw).
   */
  private mapResponse(
    map: unknown,
    scope: { body: unknown; status: number; ok: boolean },
  ): Record<string, unknown> | undefined {
    if (!map || typeof map !== 'object') return undefined;
    const out: Record<string, unknown> = {};
    for (const [key, expr] of Object.entries(map as Record<string, unknown>)) {
      if (typeof expr !== 'string') continue;
      out[key] = this.evalJsonPath(expr, scope);
    }
    return out;
  }

  private evalJsonPath(
    expr: string,
    scope: { body: unknown; status: number; ok: boolean },
  ): unknown {
    if (expr === '$.status') return scope.status;
    if (expr === '$.ok') return scope.ok;
    if (!expr.startsWith('$')) return expr; // literal
    // $.foo.bar → walk the body
    const path = expr.replace(/^\$\.?/, '');
    if (!path) return scope.body;
    return this.lookup(scope.body as Record<string, unknown>, path);
  }

  private lookup(obj: unknown, path: string): unknown {
    return path
      .split('.')
      .reduce<unknown>(
        (acc, key) =>
          acc && typeof acc === 'object'
            ? (acc as Record<string, unknown>)[key]
            : undefined,
        obj,
      );
  }
}
