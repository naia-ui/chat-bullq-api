/**
 * Tipos compartilhados pelo módulo do watchdog.
 *
 * O watchdog detecta conversas onde a IA travou ou o humano abandonou e
 * reativa o atendimento. Roda em duas camadas:
 *
 *  1) Reativa: toda inbound de cliente agenda um job com `delay` na fila
 *     `watchdog-timers`. Se a conversa avança (IA/humano respondem), o job
 *     é cancelado. Se o tempo passa sem avanço, dispara a checagem.
 *
 *  2) Cron de fallback: a cada N minutos varre conversas potencialmente
 *     presas que escaparam da camada reativa (Redis caiu, deploy reiniciou,
 *     conversa antiga sem job registrado) e enfileira jobs reativos.
 */

/** Nome da fila BullMQ. */
export const WATCHDOG_QUEUE = 'watchdog-timers';

/** Nome do job reativo (delay-based, agendado por mensagem INBOUND). */
export const WATCHDOG_CHECK_JOB = 'watchdog-check';

/** Nome do repeatable cron de fallback. */
export const WATCHDOG_FALLBACK_JOB = 'watchdog-fallback-scan';

/** Defaults — usados quando `org.watchdogConfig` é null ou faltando keys. */
export const DEFAULT_WATCHDOG_CONFIG: Required<WatchdogConfig> = {
  delayBotMin: 15,
  delayPendingMin: 15,
  delayHumanIdleMin: 60,
  maxAttempts: 3,
};

/** Intervalo do cron de fallback. */
export const WATCHDOG_FALLBACK_PATTERN = '*/15 * * * *'; // a cada 15min

/** Nome do repeatable cron de retry de conversas presas ("toda manhã"). */
export const WATCHDOG_STUCK_RETRY_JOB = 'watchdog-stuck-retry';

/**
 * Horário do retry diário de conversas presas — sobreponível via env
 * WATCHDOG_STUCK_RETRY_PATTERN. Default 8h da manhã, horário de Brasília
 * (ver `tz` no registro do repeatable job — cron sem tz roda em UTC, que
 * seria 5h da manhã de verdade, não 8h).
 */
export const WATCHDOG_STUCK_RETRY_PATTERN_DEFAULT = '0 8 * * *';

export interface WatchdogConfig {
  /** Minutos sem resposta com status=BOT antes de reativar IA. */
  delayBotMin?: number;
  /** Minutos sem resposta com status=PENDING antes de IA assumir. */
  delayPendingMin?: number;
  /** Minutos sem resposta com status=OPEN (humano atribuído) antes de IA reassumir. */
  delayHumanIdleMin?: number;
  /** Tentativas antes de marcar como `isStuck`. */
  maxAttempts?: number;
}

export interface WatchdogJobData {
  conversationId: string;
  organizationId: string;
  /** Tentativa atual quando o job foi agendado. Defensa contra duplicatas. */
  scheduledAtAttempts: number;
}
