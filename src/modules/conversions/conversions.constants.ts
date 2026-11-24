/**
 * Números e nomes fixos do envio de conversão. Arquivo sem dependência,
 * para poder ser importado de serviço, worker e teste.
 */

export const CONVERSIONS_QUEUE = 'conversion-dispatch';
export const CONVERSIONS_JOB = 'dispatch-due';

/** A cada 15 minutos. A carência é de horas; não há pressa de minutos. */
export const DISPATCH_PATTERN_DEFAULT = '*/15 * * * *';

/** Quantas linhas uma passada do despachante processa. */
export const DISPATCH_BATCH_SIZE = 25;

/**
 * Janelas de aceitação das plataformas. Evento mais velho que isso é
 * descartado com motivo — a data **nunca** é ajustada para caber.
 * [VERIFICAR] ambos os prazos na documentação vigente antes de ligar.
 */
export const META_WINDOW_DAYS = 7;
export const GOOGLE_WINDOW_DAYS = 90;

/**
 * Carência: tempo entre marcar a etapa e a conversão sair. É a janela para
 * desfazer um clique errado antes de a plataforma receber.
 */
export const DEFAULT_GRACE_HOURS = 24;

/** Nomes de evento neutros — nunca revelam a área do Direito. */
export const EVENT_NAME_LEAD = 'Lead';
export const EVENT_NAME_SCHEDULE = 'Schedule';
export const EVENT_NAME_CONTRACT = 'Contrato';

export const EVENT_NAMES = [
  EVENT_NAME_LEAD,
  EVENT_NAME_SCHEDULE,
  EVENT_NAME_CONTRACT,
] as const;

export type ConversionEventName = (typeof EVENT_NAMES)[number];

/**
 * Palavras na chave ou no nome da etapa que indicam consulta agendada.
 * Etapa do tipo WON vira contrato; o resto cai em Lead.
 */
export const SCHEDULE_STAGE_HINTS = [
  'schedule',
  'consulta',
  'agendad',
  'reuni',
];

/** Quantas tentativas de envio antes de a linha parar de ser reprocessada. */
export const MAX_SEND_ATTEMPTS = 5;
