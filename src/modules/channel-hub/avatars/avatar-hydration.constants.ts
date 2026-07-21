export const AVATAR_HYDRATION_QUEUE = 'avatar-hydration';

/**
 * Espaçamento entre uma busca de foto e a seguinte.
 *
 * O provider limita a ~1 requisição por segundo por instância, e cada foto
 * custa DUAS (buscar o chat + baixar a imagem). 1,5s dá folga sem fazer o
 * inbox demorar: as 10 primeiras conversas ficam prontas em ~15s.
 */
export const AVATAR_HYDRATION_SPACING_MS = 1_500;

/** Quantas conversas sem foto tentamos por vez ao abrir o inbox. */
export const AVATAR_HYDRATION_BATCH = 10;

/**
 * Prazo da cópia local quando a pessoa ABRE a conversa. Curto de propósito:
 * é aí que ela quer ver a foto atual do contato/grupo. Na varredura de fundo
 * o prazo continua sendo o do enricher (7 dias).
 */
export const AVATAR_REFRESH_ON_OPEN_DAYS = 1;

export interface AvatarHydrationJob {
  channelId: string;
  externalContactId: string;
  /** Revalida mesmo que a foto local ainda esteja no prazo. */
  force?: boolean;
  /** Prazo da cópia local, em dias. Abrir a conversa usa um prazo curto. */
  maxAgeDays?: number;
}
