/**
 * Gatilho por palavra-chave da campanha de Direito Médico (Meta Ads).
 *
 * Mensagem que cita CRM, sindicância, prontuário, erro médico, processo ético
 * ou "médico/médica" vai direto pro agente de Direito Médico, sem passar pelo
 * classificador nem pela orquestradora.
 *
 * "notificação" sozinha NÃO é gatilho: é comum demais (notificação do banco,
 * do INSS, do empregador) e desviaria lead de outras áreas pro agente errado.
 * Quem recebeu notificação do CRM já cai em "crm".
 */

const TRIGGERS: RegExp[] = [
  /\bcrm\b/,
  /\bsindicancias?\b/,
  /\bprontuarios?\b/,
  /\berros? medicos?\b/,
  /\bprocessos? eticos?\b/,
  /\bmedicos?\b/,
  /\bmedicas?\b/,
];

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export function matchesMedicalLawTrigger(
  text: string | null | undefined,
): boolean {
  if (!text) return false;
  const t = normalize(text);
  return TRIGGERS.some((re) => re.test(t));
}
