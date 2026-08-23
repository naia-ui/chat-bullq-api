export const AI_RUN_HEALTH_QUEUE = 'ai-run-health';
export const AI_RUN_HEALTH_JOB = 'ai-run-health-tick';

/** Intervalo do check — sobreponível via env AI_RUN_HEALTH_CHECK_PATTERN. */
export const AI_RUN_HEALTH_CHECK_PATTERN_DEFAULT = '*/15 * * * *'; // a cada 15 min

/**
 * Janela de tempo em que os runs mais recentes são avaliados — sobreponível
 * via env AI_FAILURE_WINDOW_MINUTES.
 */
export const AI_FAILURE_WINDOW_MINUTES_DEFAULT = 30;

/**
 * Precisa de pelo menos essa quantidade de runs na janela pra concluir
 * qualquer coisa — evita falso-positivo em período de baixo volume (ex.:
 * madrugada com só 1 mensagem, que por acaso falhou). Sobreponível via env
 * AI_FAILURE_MIN_RUNS.
 */
export const AI_FAILURE_MIN_RUNS_DEFAULT = 2;

/**
 * Cooldown de re-alerta enquanto a sequência de falhas continuar —
 * sobreponível via env AI_FAILURE_ALERT_COOLDOWN_MINUTES.
 */
export const AI_FAILURE_ALERT_COOLDOWN_MINUTES_DEFAULT = 60;
