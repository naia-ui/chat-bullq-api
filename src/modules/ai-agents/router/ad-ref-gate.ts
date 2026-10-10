/**
 * Roteamento por código de anúncio (Meta Ads).
 *
 * Cada anúncio abre o WhatsApp com a frase pronta terminando em
 * "(ref. XX00)", onde XX é o prefixo da área (DM = Direito Médico) e 00 o
 * número do criativo (DM01, DM02, DMV...). Uma regra por prefixo basta: o
 * código só serve pra escolher o agente da área e medir qual anúncio converte.
 *
 * O texto do cliente NÃO é alterado — o time vê o código no inbox.
 */

/** Prefixo do código → nome EXATO do agente da área cadastrado na org. */
export const AGENT_BY_AD_PREFIX: Record<string, string> = {
  DM: 'Justine Direito Médico',
  TR: 'Justine Trabalhista',
  AG: 'Justine Agronegócio',
  BC: 'Justine Bancário e Consumidor',
  // Sucessões e patrimonial não tem agente próprio hoje; cai em Família e
  // Cível. Trocar aqui se for criado um agente dedicado.
  SP: 'Justine Família e Cível',
};

/** Tags extras por prefixo (além da `origem-<código>`). */
export const TAGS_BY_AD_PREFIX: Record<string, string[]> = {
  DM: ['dmed-campanha', 'prioridade-alta'],
};

/** Frase padrão da Meta quando o anúncio não tem mensagem personalizada. */
export const UNKNOWN_AD_ORIGIN_TAG = 'anuncio-origem-a-confirmar';

const REF_PATTERN = /\(\s*ref\.?\s*([a-z]{2}[a-z0-9]{1,3})\s*\)/i;
const META_DEFAULT_PATTERN = /mais informa[cç][oõ]es sobre isso/i;

export interface AdRef {
  /** Código em minúsculas, ex.: "dm01", "dmv". */
  code: string;
  /** Prefixo da área em maiúsculas, ex.: "DM". */
  prefix: string;
}

export function parseAdRef(text: string | null | undefined): AdRef | null {
  const match = (text ?? '').match(REF_PATTERN);
  if (!match) return null;
  const code = match[1].toLowerCase();
  return { code, prefix: code.slice(0, 2).toUpperCase() };
}

export function isMetaDefaultAdMessage(
  text: string | null | undefined,
): boolean {
  return META_DEFAULT_PATTERN.test(text ?? '');
}
