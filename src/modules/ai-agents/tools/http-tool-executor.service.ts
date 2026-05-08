import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { AiSkill, AiTool } from '@prisma/client';
import { ToolContext, ToolResult } from './tool.types';
import { PendingActionService } from '../confirmations/pending-action.service';
import type {
  ActionPreview,
  ImpactLevel,
} from '../confirmations/confirmation.types';

/**
 * Skills HTTP que NÃO podem rodar direto — viram PendingAction e só
 * executam após aprovação humana. Mapeia nome da skill → impacto.
 *
 * Match é case-sensitive e bate com o `name` que o LLM vê (mesmo nome
 * persistido em ai_skills).
 */
const DESTRUCTIVE_HTTP_SKILLS: Record<string, ImpactLevel> = {
  grantAccess: 'high',
  resetPassword: 'high',
  sendLoginLink: 'medium',
};

/**
 * Executes HTTP-backed Skills. The connection (base url + auth headers)
 * comes from the AiTool the skill is bound to; the per-call invocation
 * (path, method, body, response mapping) comes from the AiSkill itself.
 *
 * Destructive skills (ver `DESTRUCTIVE_HTTP_SKILLS`) NÃO são chamadas
 * diretamente: criamos um `PendingAction` e devolvemos pro LLM um output
 * com `requiresUserAction=true`. Quando o operador aprovar, o executor
 * da fase 2 dispara a chamada real.
 */
@Injectable()
export class HttpToolExecutorService {
  private readonly logger = new Logger(HttpToolExecutorService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly pendingActions: PendingActionService,
  ) {}

  async execute(
    skill: AiSkill,
    tool: AiTool,
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (skill.source !== 'HTTP') {
      throw new Error(`Skill ${skill.name} is not an HTTP skill`);
    }
    if (tool.source !== 'CUSTOM_HTTP') {
      throw new Error(
        `Skill ${skill.name} is HTTP but bound tool ${tool.name} isn't`,
      );
    }
    if (!tool.httpBaseUrl || !skill.httpMethod || !skill.httpPath) {
      return {
        output: {
          ok: false,
          error: 'Skill not fully configured (httpBaseUrl/httpMethod/httpPath missing)',
        },
      };
    }

    // Skills destrutivas exigem aprovação humana — short-circuit antes
    // de bater na rota real.
    const impact = DESTRUCTIVE_HTTP_SKILLS[skill.name];
    if (impact) {
      return this.gateAsPendingAction(skill, input, ctx, impact);
    }

    const url =
      this.renderTemplate(tool.httpBaseUrl, { input, ctx }).replace(/\/+$/, '') +
      '/' +
      this.renderTemplate(skill.httpPath, { input, ctx }).replace(/^\/+/, '');

    const method = skill.httpMethod.toUpperCase();
    const headers = {
      ...this.renderHeaders(tool.httpHeaders, { input, ctx }),
      ...this.renderHeaders(skill.httpHeadersExtra, { input, ctx }),
    };

    let body: string | undefined;
    if (skill.httpBodyTemplate && method !== 'GET' && method !== 'DELETE') {
      body = this.renderTemplate(skill.httpBodyTemplate, { input, ctx });
      if (!headers['content-type'] && !headers['Content-Type']) {
        headers['Content-Type'] = 'application/json';
      }
    }

    const startedAt = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      skill.timeoutMs ?? 15000,
    );

    try {
      this.logger.log(
        `[skill:${skill.name}] ${method} ${url} (timeout=${skill.timeoutMs}ms)`,
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
      } catch {}

      const ok = response.ok;
      const mapped = this.mapResponse(skill.responseMap, {
        body: parsed,
        status: response.status,
        ok,
      });
      const durationMs = Date.now() - startedAt;

      this.logger.log(
        `[skill:${skill.name}] ${response.status} in ${durationMs}ms ok=${ok}`,
      );

      const output =
        mapped !== undefined
          ? mapped
          : { ok, status: response.status, body: parsed };

      return { output };
    } catch (err: any) {
      const isTimeout = err?.name === 'AbortError';
      const message = isTimeout
        ? `Skill ${skill.name} timed out after ${skill.timeoutMs}ms`
        : err?.message ?? String(err);
      this.logger.error(`[skill:${skill.name}] failed: ${message}`);
      return {
        output: { ok: false, error: message, timeout: isTimeout },
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  // ─── helpers ───────────────────────────────────────────────────

  /**
   * Cria um PendingAction pra skill destrutiva e devolve um ToolResult que
   * sinaliza pro LLM "tá em revisão humana, não execute follow-up".
   */
  private async gateAsPendingAction(
    skill: AiSkill,
    input: Record<string, unknown>,
    ctx: ToolContext,
    impact: ImpactLevel,
  ): Promise<ToolResult> {
    const preview: ActionPreview = {
      action: this.buildPreviewAction(skill.name, input),
      impact,
      rollback: this.buildRollback(skill.name),
      affectedEntity: {
        type: 'contact',
        id: ctx.contactId,
        label: this.guessContactLabel(input) ?? `contact:${ctx.contactId}`,
      },
    };

    const action = await this.pendingActions.create({
      agentRunId: ctx.runId,
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      toolName: skill.name,
      args: input,
      preview,
    });

    this.logger.log(
      `[skill:${skill.name}] gated as pendingAction=${action.id} (impact=${impact})`,
    );

    return {
      output: {
        ok: true,
        pendingActionId: action.id,
        requiresUserAction: true,
        preview,
        message: 'Aguardando aprovação humana antes de executar.',
      },
    };
  }

  private buildPreviewAction(
    skillName: string,
    input: Record<string, unknown>,
  ): string {
    const email = this.guessContactLabel(input);
    const offer =
      typeof input.offerSlug === 'string'
        ? input.offerSlug
        : typeof input.offer === 'string'
          ? input.offer
          : undefined;

    switch (skillName) {
      case 'grantAccess':
        return offer
          ? `Liberar acesso de ${email ?? 'cliente'} ao(à) "${offer}"`
          : `Liberar acesso de ${email ?? 'cliente'} na área de membros`;
      case 'resetPassword':
        return `Resetar senha de ${email ?? 'cliente'} na área de membros`;
      case 'sendLoginLink':
        return `Enviar link mágico de login pra ${email ?? 'cliente'}`;
      default:
        return `Executar ${skillName}`;
    }
  }

  private buildRollback(skillName: string): string | undefined {
    switch (skillName) {
      case 'grantAccess':
        return 'Revogar acesso via revokeAccess (ou painel admin do Trivapp).';
      case 'resetPassword':
        return 'Não há rollback automático — orientar o cliente a definir nova senha.';
      case 'sendLoginLink':
        return 'Link expira sozinho; sem rollback necessário.';
      default:
        return undefined;
    }
  }

  private guessContactLabel(
    input: Record<string, unknown>,
  ): string | undefined {
    const email = input.email;
    if (typeof email === 'string' && email.trim()) return email.trim();
    return undefined;
  }

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
    if (!expr.startsWith('$')) return expr;
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
