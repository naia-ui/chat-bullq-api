export interface BusinessHoursDay {
  enabled: boolean;
  windows?: Array<[string, string]>; // [["09:00","18:00"]]
}
export type BusinessHoursConfig = Record<string, BusinessHoursDay>;

const DAY_KEYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

/**
 * Única implementação de "está dentro do horário configurado". Existiam
 * DUAS cópias quase idênticas dessa lógica (AgentRouterService lendo
 * `org.aiBusinessHours` e WatchdogConfigService lendo
 * `org.watchdogBusinessHours`) que divergiram e causaram um bug real em
 * produção (05/08/2026 — um caminho achava que estava dentro do horário
 * enquanto o outro achava que não). Não duplicar de novo — qualquer
 * consumidor de "dentro do horário" passa pela mesma função.
 */
export function isWithinBusinessHours(
  config: unknown,
  timezone: string | null | undefined,
): boolean {
  if (!config) return true; // sem config = 24/7

  const cfg = config as BusinessHoursConfig;
  const tz = timezone || 'America/Sao_Paulo';

  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    weekday: 'long',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  const parts = fmt.formatToParts(new Date());
  const weekday =
    parts.find((p) => p.type === 'weekday')?.value.toLowerCase() ?? '';
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const nowMinutes = parseInt(hour, 10) * 60 + parseInt(minute, 10);

  if (!DAY_KEYS.includes(weekday as (typeof DAY_KEYS)[number])) {
    return true;
  }
  const day = cfg[weekday];
  if (!day || !day.enabled) return false;

  const windows = day.windows ?? [];
  if (windows.length === 0) return true;

  return windows.some(([from, to]) => {
    const fromMin = parseHourToMinutes(from);
    const toMin = parseHourToMinutes(to);
    return nowMinutes >= fromMin && nowMinutes < toMin;
  });
}

function parseHourToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map((v) => parseInt(v, 10));
  return (h || 0) * 60 + (m || 0);
}
