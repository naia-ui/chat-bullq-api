/** Fila BullMQ que processa os webhooks da Kirvano de forma assíncrona. */
export const KIRVANO_EVENTS_QUEUE = 'kirvano-events';

/** Job repeat do watchdog de cards parados na recuperação. */
export const RECOVERY_WATCHDOG_QUEUE = 'recovery-watchdog';
export const RECOVERY_WATCHDOG_JOB = 'scan-stuck-cards';

/** Fila do disparo do opener (com delay por tipo de evento). */
export const RECOVERY_OUTREACH_QUEUE = 'recovery-outreach';
export const RECOVERY_OUTREACH_JOB = 'dispatch-outreach';
