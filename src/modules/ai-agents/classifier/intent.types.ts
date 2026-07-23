/**
 * Tipos canônicos do Intent Classifier.
 *
 * O classifier roda ANTES do fallback (orquestrador, quando existir um pro
 * canal) e usa o modelo barato pra decidir qual agente chamar quando dá pra
 * ter certeza. Isso economiza custo + latência em mensagens onde o
 * roteamento é óbvio.
 *
 * Mensagens com intent ambíguo, small talk, spam ou pedido de escalação caem
 * de volta no fallback (skippedOrchestrator=false), que continua sendo
 * o caminho seguro pra qualquer coisa fora-da-curva.
 */

export enum IntentType {
  /** Relato de problema jurídico ou pedido de atendimento → agente de triagem (ex.: Justine Trabalhista) */
  LEGAL_MATTER = 'LEGAL_MATTER',
  /** Oi/bom dia/agradecimento — sem pedido claro ainda */
  SMALL_TALK = 'SMALL_TALK',
  /** Não dá pra decidir → cai no fallback */
  AMBIGUOUS = 'AMBIGUOUS',
  /** Spam de verdade: propaganda, link suspeito, mensagem sem sentido — NUNCA uma saudação simples */
  SPAM_OR_NOISE = 'SPAM_OR_NOISE',
  /** Cliente irritado/ameaça/reclamação grave/mídia → prioriza humano */
  ESCALATE_HUMAN = 'ESCALATE_HUMAN',
}

/** Mensagem do histórico recente passada como contexto ao classifier. */
export interface ClassifierMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ClassificationResult {
  intent: IntentType;
  /** 0.0 — 1.0. Abaixo do threshold cai pro orchestrator. */
  confidence: number;
  /** Explicação curta do Fugu — útil pra debug e auditoria. */
  reasoning: string;
  /** Nome do agente resolvido pelo IntentRouterService, ou null quando cai no fallback. */
  suggestedAgent: string | null;
  /** true quando confidence >= threshold E intent não é AMBIGUOUS/SPAM/ESCALATE. */
  skippedOrchestrator: boolean;
  /** ID do modelo realmente usado (ex.: 'anthropic/claude-haiku-4-5-20251001'). */
  modelUsed: string;
  /** Custo desta classificação em USD. */
  costUsd: number;
  /** Latência total da chamada em ms. */
  durationMs: number;
}

export interface ClassifierConfig {
  /** Default 0.85. Abaixo disso → fallback pro orchestrator. */
  threshold: number;
  /** Default DEFAULT_SIMPLE_MODEL (anthropic/claude-haiku-4-5-20251001). */
  model: string;
}
