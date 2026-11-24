import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  ConversionPlatform,
  ConversionStatus,
  Prisma,
  PipelineStageType,
} from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { ConversionsConfigService } from './conversions.config';
import { GoogleAdsAdapter } from './adapters/google-ads.adapter';
import { MetaCapiAdapter, PlatformSendResult } from './adapters/meta-capi.adapter';
import {
  ConversionEventName,
  DISPATCH_BATCH_SIZE,
  EVENT_NAME_CONTRACT,
  EVENT_NAME_LEAD,
  EVENT_NAME_SCHEDULE,
  GOOGLE_WINDOW_DAYS,
  MAX_SEND_ATTEMPTS,
  META_WINDOW_DAYS,
  SCHEDULE_STAGE_HINTS,
} from './conversions.constants';
import {
  eligiblePlatforms,
  ineligibilityReason,
  readOriginFacts,
} from './origin';

/**
 * Fila de conversões: enfileira a intenção quando o card chega à etapa,
 * espera a carência e devolve o fato à plataforma de anúncio.
 *
 * Três garantias, todas no banco e não na boa vontade do código:
 *  - uma linha por (card, etapa, plataforma) — a mesma conversão não sai
 *    duas vezes, nem com reentrega de evento, nem com card movido de ida e
 *    volta;
 *  - nada sai antes da carência, e sair exige as duas chaves ligadas
 *    (geral + plataforma) mais a simulação desligada;
 *  - evento fora da janela da plataforma é descartado com motivo. A data
 *    nunca é ajustada para caber.
 */
@Injectable()
export class ConversionsService {
  private readonly logger = new Logger(ConversionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConversionsConfigService,
    private readonly meta: MetaCapiAdapter,
    private readonly google: GoogleAdsAdapter,
  ) {}

  // ─── Entrada: o card chegou numa etapa ──────────────────────────────

  /**
   * Põe na fila a conversão da etapa atual do card. Idempotente: chamar
   * duas vezes para o mesmo (card, etapa) não gera envio novo.
   */
  async enqueueForCardStage(input: {
    organizationId: string;
    cardId: string;
    /** Força o nome do evento; na ausência, deriva da etapa. */
    eventName?: ConversionEventName;
  }): Promise<{
    queued: Array<{ platform: ConversionPlatform; matchKind: string }>;
    skipped?: string;
    eventName?: string;
  }> {
    const card = await this.prisma.card.findFirst({
      where: { id: input.cardId, organizationId: input.organizationId },
      include: {
        stage: { select: { id: true, key: true, name: true, type: true } },
        contact: { select: { id: true, phone: true, metadata: true } },
      },
    });
    if (!card) throw new NotFoundException('Card não encontrado');

    // Etapa desfeita: o que estava pendente de OUTRA etapa deste card
    // perde sentido e é cancelado antes de qualquer envio.
    await this.cancelPendingOnMove(this.prisma, card.id, card.stageId);

    const eventName =
      input.eventName ?? eventNameForStage(card.stage);

    const facts = readOriginFacts({
      contactMetadata: card.contact?.metadata,
      cardMetadata: card.metadata,
      phone: card.contact?.phone ?? null,
    });

    const matches = eligiblePlatforms(facts);
    if (matches.length === 0) {
      const reason = ineligibilityReason(facts);
      this.logger.log(
        `conversion_skipped card=${card.id} stage=${card.stage.name}: ${reason}`,
      );
      return { queued: [], skipped: reason, eventName };
    }

    const occurredAt = card.closedAt ?? new Date();
    const releaseAt = new Date(
      occurredAt.getTime() + this.config.graceHours * 3_600_000,
    );
    const value =
      this.config.sendRealValue && card.value != null ? card.value : null;

    const queued: Array<{ platform: ConversionPlatform; matchKind: string }> = [];

    for (const match of matches) {
      const platform =
        match.platform === 'META'
          ? ConversionPlatform.META
          : ConversionPlatform.GOOGLE;

      const existing = await this.prisma.conversionEvent.findUnique({
        where: {
          uq_conversion_card_stage_platform: {
            cardId: card.id,
            stageId: card.stage.id,
            platform,
          },
        },
        select: { id: true, status: true },
      });

      // Já enviada ou já esperando a carência: não mexe. Qualquer outro
      // estado (recusada, descartada, cancelada) volta para a fila com os
      // dados de agora — é assim que "chegou o gclid" ou "configurei a
      // ação de conversão" se resolve sem intervenção no banco.
      if (
        existing &&
        (existing.status === ConversionStatus.SENT ||
          existing.status === ConversionStatus.PENDING)
      ) {
        continue;
      }

      const data = {
        organizationId: card.organizationId,
        cardId: card.id,
        contactId: card.contact?.id ?? null,
        platform,
        eventName,
        stageId: card.stage.id,
        stageLabel: card.stage.name,
        matchKind: match.matchKind,
        matchValue: match.matchValue,
        campaignCode: facts.campaignCode,
        value,
        currency: card.currency ?? 'BRL',
        occurredAt,
        releaseAt,
        status: ConversionStatus.PENDING,
        attemptCount: 0,
        lastError: null,
        dryRun: this.config.dryRun,
        sentAt: null,
        response: Prisma.DbNull,
      };

      if (existing) {
        await this.prisma.conversionEvent.update({
          where: { id: existing.id },
          data,
        });
      } else {
        await this.prisma.conversionEvent.create({ data });
      }

      queued.push({ platform, matchKind: match.matchKind });
    }

    return { queued, eventName };
  }

  /**
   * Cancela o que está pendente para o card em etapas que não são a atual.
   * Chamado pelo movimento do card — dentro da mesma transação, para que
   * desfazer a etapa e cancelar a conversão sejam o mesmo fato.
   */
  async cancelPendingOnMove(
    txOrClient: Prisma.TransactionClient | PrismaService,
    cardId: string,
    currentStageId: string,
  ): Promise<number> {
    const result = await txOrClient.conversionEvent.updateMany({
      where: {
        cardId,
        stageId: { not: currentStageId },
        status: ConversionStatus.PENDING,
      },
      data: {
        status: ConversionStatus.CANCELLED,
        lastError: 'etapa desfeita antes do envio',
      },
    });
    return result.count;
  }

  // ─── Saída: o despachante ───────────────────────────────────────────

  /** Processa o que venceu a carência. Chamado pelo cron e pela rota. */
  async dispatchDue(limit = DISPATCH_BATCH_SIZE): Promise<{
    processed: number;
    sent: number;
    failed: number;
    skipped: number;
    previewed: number;
  }> {
    const now = new Date();
    const due = await this.prisma.conversionEvent.findMany({
      where: { status: ConversionStatus.PENDING, releaseAt: { lte: now } },
      orderBy: { releaseAt: 'asc' },
      take: limit,
    });

    const tally = { processed: 0, sent: 0, failed: 0, skipped: 0, previewed: 0 };

    for (const row of due) {
      tally.processed += 1;

      // 1. Janela da plataforma. Fora dela, descarta com motivo.
      const windowDays =
        row.platform === ConversionPlatform.META
          ? META_WINDOW_DAYS
          : GOOGLE_WINDOW_DAYS;
      const ageDays =
        (now.getTime() - row.occurredAt.getTime()) / 86_400_000;
      if (ageDays > windowDays) {
        await this.prisma.conversionEvent.update({
          where: { id: row.id },
          data: {
            status: ConversionStatus.SKIPPED,
            lastError: `fora da janela de ${windowDays} dias (${Math.floor(ageDays)} dias)`,
          },
        });
        tally.skipped += 1;
        continue;
      }

      // 2. Chaves. Desligada = fica PENDENTE com a pré-visualização
      // gravada. Nada se perde; a fila drena quando você ligar.
      const off = this.config.platformOffReason(
        row.platform === ConversionPlatform.META ? 'META' : 'GOOGLE',
      );
      if (off || this.config.dryRun) {
        await this.savePreview(row, off ?? 'CONVERSIONS_DRY_RUN ligado');
        tally.previewed += 1;
        continue;
      }

      // 3. Envio real.
      const result = await this.sendRow(row);
      const attemptCount = row.attemptCount + 1;

      if (result.ok) {
        await this.prisma.conversionEvent.update({
          where: { id: row.id },
          data: {
            status: ConversionStatus.SENT,
            sentAt: new Date(),
            attemptCount,
            lastError: null,
            dryRun: false,
            response: toJson(result.response),
          },
        });
        tally.sent += 1;
        continue;
      }

      const giveUp = !result.retryable || attemptCount >= MAX_SEND_ATTEMPTS;
      await this.prisma.conversionEvent.update({
        where: { id: row.id },
        data: {
          status: giveUp ? ConversionStatus.FAILED : ConversionStatus.PENDING,
          attemptCount,
          lastError: (result.errorMessage ?? 'erro desconhecido').slice(0, 500),
          response: toJson(result.response),
        },
      });
      if (giveUp) tally.failed += 1;
    }

    if (tally.processed > 0) {
      this.logger.log(
        `conversion_dispatch processed=${tally.processed} sent=${tally.sent} ` +
          `failed=${tally.failed} skipped=${tally.skipped} previewed=${tally.previewed}`,
      );
    }
    return tally;
  }

  private async sendRow(row: {
    id: string;
    platform: ConversionPlatform;
    eventName: string;
    occurredAt: Date;
    matchKind: string;
    matchValue: string;
    value: Prisma.Decimal | null;
    currency: string;
  }): Promise<PlatformSendResult> {
    const value = row.value != null ? Number(row.value) : null;
    if (row.platform === ConversionPlatform.META) {
      return this.meta.send({
        eventId: row.id,
        eventName: row.eventName,
        occurredAt: row.occurredAt,
        matchKind: row.matchKind,
        matchValue: row.matchValue,
        value,
        currency: row.currency,
      });
    }
    return this.google.send({
      eventName: row.eventName,
      occurredAt: row.occurredAt,
      matchKind: row.matchKind,
      matchValue: row.matchValue,
      value,
      currency: row.currency,
    });
  }

  /** Monta o envio e grava como pré-visualização, sem chamar ninguém. */
  private async savePreview(
    row: {
      id: string;
      platform: ConversionPlatform;
      eventName: string;
      occurredAt: Date;
      matchKind: string;
      matchValue: string;
      value: Prisma.Decimal | null;
      currency: string;
    },
    reason: string,
  ): Promise<void> {
    const value = row.value != null ? Number(row.value) : null;
    const preview =
      row.platform === ConversionPlatform.META
        ? this.meta.buildPayload({
            eventId: row.id,
            eventName: row.eventName,
            occurredAt: row.occurredAt,
            matchKind: row.matchKind,
            matchValue: row.matchValue,
            value,
            currency: row.currency,
          })
        : this.google.buildPayload({
            eventName: row.eventName,
            occurredAt: row.occurredAt,
            matchKind: row.matchKind,
            matchValue: row.matchValue,
            value,
            currency: row.currency,
            validateOnly: true,
          });

    await this.prisma.conversionEvent.update({
      where: { id: row.id },
      data: {
        dryRun: true,
        lastError: `simulação: ${reason}`,
        response: {
          dryRun: true,
          reason,
          previewedAt: new Date().toISOString(),
          preview,
        } as Prisma.InputJsonValue,
      },
    });
  }

  // ─── Operação ───────────────────────────────────────────────────────

  /** Devolve à fila uma linha recusada ou descartada. */
  async retry(id: string, organizationId: string) {
    const row = await this.prisma.conversionEvent.findFirst({
      where: { id, organizationId },
      select: { id: true, status: true },
    });
    if (!row) throw new NotFoundException('Conversão não encontrada');
    if (
      row.status !== ConversionStatus.FAILED &&
      row.status !== ConversionStatus.SKIPPED &&
      row.status !== ConversionStatus.CANCELLED
    ) {
      return { id: row.id, status: row.status, changed: false };
    }
    const updated = await this.prisma.conversionEvent.update({
      where: { id: row.id },
      data: {
        status: ConversionStatus.PENDING,
        releaseAt: new Date(),
        attemptCount: 0,
        lastError: null,
      },
      select: { id: true, status: true },
    });
    return { ...updated, changed: true };
  }

  /**
   * Relatório da fila: o que saiu, o que espera, o que falhou e por quê.
   * Não devolve o identificador de correspondência — só o tipo dele.
   */
  async report(organizationId: string, days = 30) {
    const since = new Date(Date.now() - days * 86_400_000);

    const grouped = await this.prisma.conversionEvent.groupBy({
      by: ['status', 'platform'],
      where: { organizationId, createdAt: { gte: since } },
      _count: { _all: true },
    });

    const rows = await this.prisma.conversionEvent.findMany({
      where: { organizationId, createdAt: { gte: since } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: {
        id: true,
        platform: true,
        eventName: true,
        stageLabel: true,
        matchKind: true,
        campaignCode: true,
        value: true,
        currency: true,
        occurredAt: true,
        releaseAt: true,
        status: true,
        attemptCount: true,
        lastError: true,
        dryRun: true,
        sentAt: true,
        createdAt: true,
      },
    });

    return {
      periodo: { dias: days, desde: since },
      chaves: {
        geral: this.config.enabled,
        simulacao: this.config.dryRun,
        meta: this.config.platformOffReason('META') ?? 'ligada',
        google: this.config.platformOffReason('GOOGLE') ?? 'ligada',
        carenciaHoras: this.config.graceHours,
        enviaValorReal: this.config.sendRealValue,
      },
      totais: grouped.map((g) => ({
        status: g.status,
        platform: g.platform,
        total: g._count._all,
      })),
      ultimas: rows,
    };
  }
}

/** Etapa → nome de evento neutro. Nunca usa a área do Direito. */
export function eventNameForStage(stage: {
  key: string | null;
  name: string;
  type: PipelineStageType;
}): ConversionEventName {
  if (stage.type === PipelineStageType.WON) return EVENT_NAME_CONTRACT;
  const haystack = `${stage.key ?? ''} ${stage.name}`.toLowerCase();
  if (SCHEDULE_STAGE_HINTS.some((hint) => haystack.includes(hint))) {
    return EVENT_NAME_SCHEDULE;
  }
  return EVENT_NAME_LEAD;
}

function toJson(
  value: Record<string, unknown> | undefined,
): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value ? (value as Prisma.InputJsonValue) : Prisma.DbNull;
}
