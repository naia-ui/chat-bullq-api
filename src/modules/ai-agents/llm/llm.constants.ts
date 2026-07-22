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
 * Default cheap/fast model for background LLM tasks (tool iterations,
 * classification, memory extraction, eval judging) when nothing more
 * specific is configured. Only Anthropic and OpenAI are supported providers
 * — Sakana was removed.
 */
export const DEFAULT_SIMPLE_MODEL = ANTHROPIC_SIMPLE_MODEL;

/** Default model for customer-facing agent conversations (final synthesis). */
export const DEFAULT_CONVERSATION_MODEL = ANTHROPIC_CONVERSATION_MODEL;
