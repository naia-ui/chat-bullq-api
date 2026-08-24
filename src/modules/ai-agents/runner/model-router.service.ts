import { Injectable, Logger } from '@nestjs/common';

import {
  DEFAULT_CONVERSATION_MODEL,
  DEFAULT_SIMPLE_MODEL,
} from '../llm/llm.constants';

/**
 * Fase da chamada LLM dentro de um turno do agente.
 *  - `tool`      → iteração que (provavelmente) vai pedir/encadear ferramentas.
 *                  É mecânico: sempre roda no modelo barato.
 *  - `synthesis` → a resposta final ao cliente. Aqui é onde a qualidade pesa,
 *                  então workers escalam pro modelo de conversa; o
 *                  orquestrador (triagem) fica no barato.
 */
export type LlmPhase = 'tool' | 'synthesis';

export type AgentKind = 'ORCHESTRATOR' | 'WORKER';

/**
 * Override opcional por agente, gravado em `AiAgent.modelParams.routing`
 * (coluna JSON já existente — sem migration). Ex.:
 *   { "routing": { "primary": "anthropic/claude-haiku-4-5-20251001",
 *                  "escalation": "anthropic/claude-sonnet-5",
 *                  "alwaysPrimary": false,
 *                  "escalateSynthesis": true } }
 */
interface RoutingOverride {
  primary?: string;
  escalation?: string;
  /** Trava o agente inteiro no modelo barato (nunca escala). */
  alwaysPrimary?: boolean;
  /** Força/inibe escalonamento da síntese independente do kind. */
  escalateSynthesis?: boolean;
}

export interface SelectModelInput {
  agentKind: AgentKind;
  /** `AiAgent.modelId` — usado como modelo de escalonamento default. */
  modelId: string;
  /** `AiAgent.modelParams` cru do banco. */
  modelParams?: Record<string, unknown> | null;
  phase: LlmPhase;
}

/**
 * Decide qual modelo usar em cada chamada do loop do agente. Providers
 * suportados: Anthropic (Claude), OpenAI (GPT) e Gemini (Google) — Sakana
 * foi removido.
 *
 * Estratégia (objetivo: usar o modelo barato o máximo possível):
 *  - Toda iteração de ferramenta roda no modelo barato (baixa latência).
 *  - A síntese final:
 *      • WORKER (especialista de vendas/suporte/impl) → escala pro modelo de
 *        conversa (é a resposta que o cliente lê; qualidade importa).
 *      • ORCHESTRATOR (triagem/small-talk/ambíguo) → fica no barato.
 *  - Qualquer agente pode sobrescrever via `modelParams.routing`.
 *
 * BUG REAL corrigido em 24/08/2026: `sanitizeModel()` só reconhecia prefixos
 * Anthropic/OpenAI. Quando o Gemini foi integrado no LlmService (22/08), essa
 * allowlist não foi atualizada — todo agente configurado com
 * `google/gemini-*` caía no fallback Anthropic aqui DENTRO, silenciosamente,
 * antes mesmo de chegar no LlmService (que já suportava Gemini
 * corretamente). Resultado: com a Anthropic sem crédito, 100% dos runs de
 * TODOS os agentes falhavam, mesmo os já trocados pra Gemini na UI — o
 * agent.modelId salvo no banco nunca era de fato usado na chamada.
 */
@Injectable()
export class ModelRouterService {
  private readonly logger = new Logger(ModelRouterService.name);

  selectModel(input: SelectModelInput): string {
    const routing = this.parseRouting(input.modelParams);

    // Sanitiza pra GARANTIR que só saem daqui modelos Anthropic ou OpenAI
    // reconhecidos. Overrides mal preenchidos (vazio, lixo, ou um modelId
    // legado de um provider removido) caem no fallback informado em vez de
    // quebrar no provider.
    const primary = this.sanitizeModel(routing.primary, DEFAULT_SIMPLE_MODEL);
    const escalation = this.sanitizeModel(
      routing.escalation ?? input.modelId,
      DEFAULT_CONVERSATION_MODEL,
    );

    if (routing.alwaysPrimary) return primary;

    // Iterações de ferramenta são sempre baratas.
    if (input.phase === 'tool') return primary;

    // Síntese final: decide se escala.
    const escalate =
      routing.escalateSynthesis ?? input.agentKind === 'WORKER';

    return escalate ? escalation : primary;
  }

  /**
   * Garante que o modelo é um ID reconhecido — Anthropic (anthropic/*,
   * claude-*), OpenAI (openai/*, gpt-*) ou Gemini (google/*, gemini-*).
   * Qualquer outra coisa (override quebrado, vazio, ou um modelId legado de
   * provider removido como Sakana) cai no fallback informado.
   */
  private sanitizeModel(model: string | undefined | null, fallback: string): string {
    const m = (model ?? '').trim();
    if (
      m.startsWith('anthropic/') ||
      m.startsWith('claude-') ||
      m.startsWith('openai/') ||
      m.startsWith('gpt-') ||
      m.startsWith('google/') ||
      m.startsWith('gemini-')
    ) {
      return m;
    }
    return fallback;
  }

  private parseRouting(
    modelParams: Record<string, unknown> | null | undefined,
  ): RoutingOverride {
    const raw = modelParams?.routing;
    if (!raw || typeof raw !== 'object') return {};
    const r = raw as Record<string, unknown>;
    return {
      primary: typeof r.primary === 'string' ? r.primary : undefined,
      escalation: typeof r.escalation === 'string' ? r.escalation : undefined,
      alwaysPrimary: r.alwaysPrimary === true,
      escalateSynthesis:
        typeof r.escalateSynthesis === 'boolean'
          ? r.escalateSynthesis
          : undefined,
    };
  }
}
