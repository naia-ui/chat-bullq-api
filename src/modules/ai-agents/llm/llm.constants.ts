/** Cheap/fast Anthropic model for simple background LLM tasks. */
export const ANTHROPIC_SIMPLE_MODEL = 'anthropic/claude-haiku-4-5-20251001';

/** Anthropic model for customer-facing agent conversations. */
export const ANTHROPIC_CONVERSATION_MODEL = 'anthropic/claude-sonnet-5';

/** Highest-quality Anthropic model, for cases where quality matters more than cost/latency. */
export const ANTHROPIC_PREMIUM_MODEL = 'anthropic/claude-opus-4-8';

/** Cheap/fast OpenAI model for simple background LLM tasks. */
export const OPENAI_SIMPLE_MODEL = 'openai/gpt-4.1-mini';

/** OpenAI model for customer-facing agent conversations. */
export const OPENAI_CONVERSATION_MODEL = 'openai/gpt-4.1';

/**
 * Único modelo Gemini exposto no dropdown do agente por enquanto (achado
 * real 22/08/2026 — modelos "flash" puros pensam por padrão e custam muito
 * mais, ver commit da integração do Gemini). Usado como cheap E conversation
 * porque ainda não há um segundo nível Gemini configurado.
 */
export const GEMINI_SIMPLE_MODEL = 'google/gemini-flash-lite-latest';
export const GEMINI_CONVERSATION_MODEL = 'google/gemini-flash-lite-latest';

/**
 * Default cheap/fast model for background LLM tasks (tool iterations,
 * classification, memory extraction, eval judging) when nothing more
 * specific is configured. Only Anthropic and OpenAI are supported providers
 * — Sakana was removed. Só usado quando não dá pra inferir a família do
 * provider a partir do próprio agente — ver `ModelRouterService`, que usa a
 * família do `agent.modelId` em vez deste default fixo, pra não forçar
 * Anthropic num agente configurado pra outro provider.
 */
export const DEFAULT_SIMPLE_MODEL = ANTHROPIC_SIMPLE_MODEL;

/** Default model for customer-facing agent conversations (final synthesis). */
export const DEFAULT_CONVERSATION_MODEL = ANTHROPIC_CONVERSATION_MODEL;
