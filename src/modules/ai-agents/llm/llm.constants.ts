/** Default Sakana model for cheap/simple background LLM tasks. */
export const SAKANA_SIMPLE_MODEL = 'sakana/fugu';

/** Default Sakana model for customer-facing agent conversations. */
export const SAKANA_CONVERSATION_MODEL = 'sakana/fugu-ultra-20260615';

/** Default OpenAI-compatible base URL for Sakana's API. */
export const SAKANA_DEFAULT_BASE_URL = 'https://api.sakana.ai/v1';

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
