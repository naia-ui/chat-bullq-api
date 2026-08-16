export const ZAPPFY_HEALTH_QUEUE = 'zappfy-connection-health';
export const ZAPPFY_HEALTH_JOB = 'zappfy-health-tick';

/** Intervalo do check de saúde — sobreponível via env ZAPPFY_HEALTH_CHECK_PATTERN. */
export const ZAPPFY_HEALTH_CHECK_PATTERN_DEFAULT = '*/10 * * * *'; // a cada 10 min

/**
 * Intervalo mínimo entre re-alertas pro MESMO canal enquanto ele continuar
 * desconectado — evita spam de e-mail a cada tick numa queda prolongada.
 * Sobreponível via env ZAPPFY_HEALTH_ALERT_COOLDOWN_MINUTES.
 */
export const ZAPPFY_HEALTH_ALERT_COOLDOWN_MINUTES_DEFAULT = 60; // 1x por hora enquanto down
