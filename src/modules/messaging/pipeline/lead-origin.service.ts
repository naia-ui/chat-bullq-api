import { Injectable, Logger } from '@nestjs/common';
import { AutomationTrigger, Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { OutboxService } from '../../automations/outbox/outbox.service';

/**
 * Controle de origem de lead (site / landing page / Google Ads / etc.).
 *
 * Sem integração oficial da Meta (canal é Zappfy, não WhatsApp Cloud API),
 * não existe um `referral` object automático vindo do clique — a única
 * informação que atravessa o clique é o texto pré-preenchido do link
 * `https://wa.me/<numero>?text=...`. Convenção adotada (pedido da usuária
 * 25/08/2026, "controle de origem do site ou da landing page"):
 *
 *   qualquer texto pré-preenchido termina com `#origem:<slug>`
 *   ex.: "Olá, vim do site sobre Direito Médico #origem:site-direito-medico"
 *
 * Só é reconhecido na PRIMEIRA mensagem de um contato genuinamente novo —
 * evita marcar/sobrescrever origem em conversas antigas ou em réplicas de
 * quem já é contato. O sufixo é removido do texto antes de persistir/exibir
 * — nem o cliente nem o time veem o marcador cru no inbox.
 */
@Injectable()
export class LeadOriginService {
  private readonly logger = new Logger(LeadOriginService.name);

  private static readonly MARKER_PATTERN = /\s*#origem:([a-z0-9-]{1,40})\s*$/i;

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
  ) {}

  /**
   * Detecta o marcador em `text` e devolve o slug + o texto já limpo.
   * Não faz nenhuma escrita — chame `apply()` depois, só quando o contato
   * for genuinamente novo.
   */
  detect(text: string | null | undefined): {
    originSlug: string | null;
    cleanedText: string;
  } {
    const raw = text ?? '';
    const match = raw.match(LeadOriginService.MARKER_PATTERN);
    if (!match) {
      return { originSlug: null, cleanedText: raw };
    }
    const originSlug = match[1].toLowerCase();
    const cleanedText = raw.slice(0, match.index).trimEnd();
    return { originSlug, cleanedText };
  }

  /**
   * Grava a origem no contato (`metadata.origin`) e aplica a tag
   * `origem-<slug>` na conversa — mesma tabela/fluxo que `tagConversation`
   * usa, então aparece igual no inbox e em qualquer automação por tag.
   */
  async apply(
    organizationId: string,
    contactId: string,
    conversationId: string,
    originSlug: string,
  ): Promise<void> {
    try {
      const contact = await this.prisma.contact.findUnique({
        where: { id: contactId },
        select: { metadata: true },
      });
      const existingMetadata = (contact?.metadata ?? {}) as Record<
        string,
        unknown
      >;
      await this.prisma.contact.update({
        where: { id: contactId },
        data: {
          metadata: {
            ...existingMetadata,
            origin: originSlug,
            originDetectedAt: new Date().toISOString(),
          } as Prisma.InputJsonValue,
        },
      });

      const tagName = `origem-${originSlug}`;
      const tag = await this.prisma.tag.upsert({
        where: { organizationId_name: { organizationId, name: tagName } },
        update: {},
        create: { organizationId, name: tagName },
        select: { id: true },
      });

      await this.prisma.$transaction(async (tx) => {
        await tx.conversationTag.upsert({
          where: {
            conversationId_tagId: { conversationId, tagId: tag.id },
          },
          update: {},
          create: { conversationId, tagId: tag.id },
        });
        await this.outbox.enqueue(tx, AutomationTrigger.TAG_ADDED, {
          organizationId,
          contactId,
          conversationId,
          // sem actorId de propósito — detecção automática, não é ação de
          // humano/agente.
          tagId: tag.id,
          target: 'conversation',
        });
      });

      this.logger.log(
        `Lead origin detected: conv=${conversationId} contact=${contactId} origin=${originSlug}`,
      );
    } catch (err: unknown) {
      // Nunca deve derrubar o pipeline de ingestão por causa disso — pior
      // caso, o lead entra sem a tag de origem.
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `Failed to apply lead origin for conv ${conversationId}: ${msg}`,
      );
    }
  }
}
