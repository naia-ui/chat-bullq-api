import { Injectable, Logger } from '@nestjs/common';
import type { Message } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';

/**
 * Resolve URLs playable de mídia inbound em batch, pré-build do prompt.
 * Reusa o cache em `Message.content.mediaUrl` (mesmo campo que a UI lê
 * via MediaResolverService) então cada mensagem paga o adapter no máximo
 * uma vez.
 *
 * Por que não reusar `MediaResolverService` direto: aquele vive em
 * MessagingModule, que já importa AiAgentsModule. Importar Messaging aqui
 * fecharia o ciclo. Este service é o subset mínimo: lê content, resolve
 * via adapter, persiste.
 */
@Injectable()
export class MediaUrlResolverService {
  private readonly logger = new Logger(MediaUrlResolverService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
  ) {}

  /**
   * Garante que cada Message recebida (com type=IMAGE/VIDEO/STICKER/
   * DOCUMENT) tem `content.mediaUrl` setado. Mensagens já resolvidas são
   * no-op. Falhas são logadas mas não throw — IA segue com texto descritivo.
   *
   * Retorna um Map<messageId, {url, mimeType}> para uso direto no prompt
   * builder. Mensagens cuja resolução falhou ficam fora do map.
   */
  async resolveMany(
    messages: Message[],
    channelTypeByConversation: Map<string, string>,
  ): Promise<Map<string, { url: string; mimeType?: string }>> {
    const out = new Map<string, { url: string; mimeType?: string }>();

    const mediaTypes = new Set([
      'IMAGE',
      'VIDEO',
      'STICKER',
      'DOCUMENT',
      'AUDIO',
    ]);
    const candidates = messages.filter((m) =>
      mediaTypes.has(m.type as string),
    );
    if (candidates.length === 0) return out;

    for (const message of candidates) {
      try {
        const content = (message.content ?? {}) as Record<string, unknown>;
        const cachedUrl =
          typeof content.mediaUrl === 'string' ? content.mediaUrl : null;
        const cachedMime =
          typeof content.mimeType === 'string' ? content.mimeType : undefined;

        if (cachedUrl) {
          out.set(message.id, { url: cachedUrl, mimeType: cachedMime });
          continue;
        }

        if (!message.externalId) continue;

        const channelType = channelTypeByConversation.get(
          message.conversationId,
        );
        if (!channelType) continue;

        const adapter = this.adapterRegistry.getOutbound(channelType as never);
        if (!adapter.resolveInboundMediaUrl) continue;

        const channel = await this.prisma.channel.findFirst({
          where: { conversations: { some: { id: message.conversationId } } },
        });
        if (!channel) continue;

        const { fileUrl, mimeType } = await adapter.resolveInboundMediaUrl(
          channel,
          {
            externalMessageId: message.externalId,
            mediaId:
              typeof content.mediaId === 'string' ? content.mediaId : undefined,
            mimeType: cachedMime,
            originalFilename:
              typeof content.fileName === 'string'
                ? content.fileName
                : undefined,
          },
        );

        // Persiste no Message.content pra UI e próximos runs reusarem.
        await this.prisma.message
          .update({
            where: { id: message.id },
            data: {
              content: {
                ...content,
                mediaUrl: fileUrl,
                ...(mimeType && !cachedMime ? { mimeType } : {}),
              } as never,
            },
          })
          .catch((err: unknown) =>
            this.logger.warn(
              `media-url-resolver: failed to persist mediaUrl for msg=${message.id}: ${
                err instanceof Error ? err.message : String(err)
              }`,
            ),
          );

        out.set(message.id, {
          url: fileUrl,
          mimeType: mimeType || cachedMime,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `media-url-resolver: failed for msg=${message.id} type=${message.type}: ${msg}`,
        );
      }
    }

    return out;
  }
}
