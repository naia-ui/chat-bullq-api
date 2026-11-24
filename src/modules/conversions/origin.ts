import { createHash } from 'crypto';

/**
 * Origem do lead e identificadores de correspondência.
 *
 * Funções puras, sem Nest e sem rede — é o núcleo testável do funil. Toda
 * decisão de "para qual plataforma esse contrato volta, e com que
 * identificador" sai daqui.
 *
 * Convenções de marcador, as mesmas do link `wa.me/<numero>?text=…`:
 *
 *   `(ref. DM01)`    código do anúncio da Meta (ver ad-ref-gate.ts)
 *   `#origem:<slug>` origem do site ou landing page (ver LeadOriginService)
 *   `GT:g.<gclid>`   identificador do clique; a letra diz o tipo:
 *                    g = gclid, b = gbraid, w = wbraid, f = fbclid
 *
 * O identificador do clique é dado pseudonimizado e passa a constar na
 * conversa e no banco. Telefone **nunca** é gravado aqui em claro: para a
 * Meta sai só o SHA-256; para o Google, só o identificador do clique.
 */

export type ClickKind = 'gclid' | 'gbraid' | 'wbraid' | 'fbclid' | 'ctwa_clid';

export interface ClickRef {
  kind: ClickKind;
  value: string;
}

export type ConversionPlatformName = 'META' | 'GOOGLE';

export type MatchKind = 'phone_hash' | ClickKind;

export interface PlatformMatch {
  platform: ConversionPlatformName;
  matchKind: MatchKind;
  matchValue: string;
}

export interface OriginFacts {
  /** Código do anúncio ou slug do site, em minúsculas. */
  campaignCode: string | null;
  click: ClickRef | null;
  /** Telefone só como hash; null quando o contato não tem número. */
  phoneHash: string | null;
}

/**
 * Prefixos de código que são campanha da Meta.
 *
 * Precisa acompanhar os códigos que estão no ar na conta de anúncios —
 * código fora desta lista não devolve conversão. Em 23/11/2026 a conta
 * `2530951350683456` tem DM (médico), TR (trabalhista empresas), TE
 * (trabalhista empregado) e AG (agronegócio); BC e SP estão previstos no
 * roteamento por área (ver AGENT_BY_AD_PREFIX em ad-ref-gate.ts, que ainda
 * não mapeia TE).
 */
export const META_AD_PREFIXES = ['DM', 'TR', 'TE', 'AG', 'BC', 'SP'] as const;

/** Slugs de origem que indicam Google (quando não há gclid no texto). */
const GOOGLE_SLUG_PATTERN = /^(google|gads|g-ads|search|gt)[-_]?/i;

const CLICK_KIND_BY_LETTER: Record<string, ClickKind> = {
  g: 'gclid',
  b: 'gbraid',
  w: 'wbraid',
  f: 'fbclid',
};

// O identificador só é aceito com 10 a 200 caracteres de letra, número, `_`
// ou `-`, e só é lido se terminar em espaço, pontuação ou fim do texto. Um
// valor estranho é ignorado: o lead fica com o código da campanha e sem
// clique, em vez de carregar lixo até a plataforma.
const CLICK_PATTERN = /GT:([gbwf])\.([A-Za-z0-9_-]{10,200})(?=[\s.,;:!?)\]]|$)/i;

/** Lê o identificador de clique do texto da primeira mensagem. */
export function parseClickRef(text: string | null | undefined): ClickRef | null {
  const match = (text ?? '').match(CLICK_PATTERN);
  if (!match) return null;
  const kind = CLICK_KIND_BY_LETTER[match[1].toLowerCase()];
  if (!kind) return null;
  return { kind, value: match[2] };
}

/** Remove o marcador de clique do texto que vai para o inbox. */
export function stripClickRef(text: string | null | undefined): string {
  const raw = text ?? '';
  const match = raw.match(CLICK_PATTERN);
  if (!match || match.index === undefined) return raw;
  const before = raw.slice(0, match.index);
  const after = raw.slice(match.index + match[0].length);
  return `${before}${after}`.replace(/\s{2,}/g, ' ').trim();
}

/**
 * Telefone em dígitos, com código do país, como a Meta espera.
 * Número brasileiro sem DDI recebe 55. Devolve null quando não dá para
 * normalizar com segurança — melhor não enviar do que enviar errado.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  const digits = (raw ?? '').replace(/\D/g, '');
  if (!digits) return null;
  if (digits.length === 10 || digits.length === 11) return `55${digits}`;
  if (digits.length >= 12 && digits.length <= 15) return digits;
  return null;
}

/** SHA-256 do telefone normalizado, em hexadecimal minúsculo. */
export function hashPhone(raw: string | null | undefined): string | null {
  const normalized = normalizePhone(raw);
  if (!normalized) return null;
  return createHash('sha256').update(normalized).digest('hex');
}

/**
 * Junta o que o contato e o card sabem sobre a origem.
 *
 * `Contact.metadata` é escrito pelo LeadOriginService na primeira mensagem
 * de um contato novo (`origin`, `clickKind`, `clickId`). `Card.metadata`
 * pode trazer os mesmos campos quando o lead entrou por formulário — e tem
 * precedência, porque é o registro mais específico.
 */
export function readOriginFacts(input: {
  contactMetadata?: unknown;
  cardMetadata?: unknown;
  phone?: string | null;
}): OriginFacts {
  const contact = asRecord(input.contactMetadata);
  const card = asRecord(input.cardMetadata);

  const campaignCode =
    firstString(card.origin, contact.origin)?.toLowerCase() ?? null;

  const kind = firstString(card.clickKind, contact.clickKind);
  const value = firstString(card.clickId, contact.clickId);
  const click =
    kind && value && isClickKind(kind) ? { kind, value } : null;

  return {
    campaignCode,
    click,
    phoneHash: hashPhone(input.phone),
  };
}

/**
 * Para quais plataformas esse lead pode devolver conversão, e com qual
 * identificador. Vazio = nenhuma; o chamador registra o motivo.
 *
 * Regras, deliberadamente estreitas:
 *  - Google só com identificador de clique do Google. Sem gclid não há como
 *    casar, e mandar hash de telefone exigiria outra configuração na conta.
 *  - Meta com `ctwa_clid` ou `fbclid` quando vierem (caminho limpo, sem dado
 *    pessoal); na falta deles, hash do telefone — mas só se a origem for
 *    reconhecidamente uma campanha da Meta, para não despejar evento de
 *    lead do Google ou do site no pixel.
 */
export function eligiblePlatforms(facts: OriginFacts): PlatformMatch[] {
  const matches: PlatformMatch[] = [];
  const { click, campaignCode, phoneHash } = facts;

  if (click && (click.kind === 'gclid' || click.kind === 'gbraid' || click.kind === 'wbraid')) {
    matches.push({
      platform: 'GOOGLE',
      matchKind: click.kind,
      matchValue: click.value,
    });
  }

  if (click && (click.kind === 'ctwa_clid' || click.kind === 'fbclid')) {
    matches.push({
      platform: 'META',
      matchKind: click.kind,
      matchValue: click.value,
    });
  } else if (phoneHash && isMetaCampaignCode(campaignCode)) {
    matches.push({
      platform: 'META',
      matchKind: 'phone_hash',
      matchValue: phoneHash,
    });
  }

  return matches;
}

/** Motivo legível quando nenhuma plataforma é elegível. */
export function ineligibilityReason(facts: OriginFacts): string {
  if (!facts.campaignCode && !facts.click) {
    return 'lead sem origem registrada (nem código de anúncio, nem clique)';
  }
  if (isGoogleOrigin(facts.campaignCode) && !facts.click) {
    return 'origem do Google sem identificador de clique — aguardando gclid';
  }
  if (isMetaCampaignCode(facts.campaignCode) && !facts.phoneHash) {
    return 'campanha da Meta, mas o contato não tem telefone para correspondência';
  }
  return `origem "${facts.campaignCode ?? '—'}" não mapeada para nenhuma plataforma`;
}

export function isMetaCampaignCode(code: string | null): boolean {
  if (!code) return false;
  const prefix = code.slice(0, 2).toUpperCase();
  return (META_AD_PREFIXES as readonly string[]).includes(prefix);
}

export function isGoogleOrigin(code: string | null): boolean {
  return !!code && GOOGLE_SLUG_PATTERN.test(code);
}

function isClickKind(value: string): value is ClickKind {
  return ['gclid', 'gbraid', 'wbraid', 'fbclid', 'ctwa_clid'].includes(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function firstString(...values: unknown[]): string | undefined {
  for (const v of values) {
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return undefined;
}
