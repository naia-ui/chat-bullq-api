import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { ConfigService } from '@nestjs/config';
import type { Queue } from 'bullmq';
import {
  ConversationStatus,
  MessageDirection,
} from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { EmailAlertService } from '../../notifications/email-alert.service';
import { WatchdogService } from './watchdog.service';
import { WatchdogConfigService } from './watchdog-config.service';
import {
  WATCHDOG_QUEUE,
  WATCHDOG_FALLBACK_JOB,
  WATCHDOG_FALLBACK_PATTERN,
  WATCHDOG_STUCK_RETRY_JOB,
  WATCHDOG_STUCK_RETRY_PATTERN_DEFAULT,
} from './watchdog.types';

/**
 * Cron de fallback: a cada 15min varre conversas potencialmente presas
 * que escaparam da camada reativa. Casos de uso:
 *
 *  - Redis caiu e perdeu jobs delay-based.
 *  - Deploy reiniciou o worker antes do delay terminar.
 *  - Conversa antiga (criada antes do watchdog existir) sem job algum.
 *  - Race onde o `scheduleCheck` falhou silenciosamente.
 *
 * Estratégia: query barata indexada por (orgId, status, lastMessageAt)
 * com WHERE deleted_at IS NULL. Filtra:
 *  - status IN (BOT, PENDING, OPEN)
 *  - lastMessageAt < now() - 15min (margem)
 *  - aiEnabled IS NOT FALSE (respeita kill switch humano)
 *  - watchdogJobId IS NULL OR job não existe mais na fila
 *  - última mensagem é INBOUND (precisa confirmar — feito por org)
 *
 * Apenas enfileira chamando `WatchdogService.scheduleCheck()` — NÃO
 * processa direto. O processor reativo decide ação centralmente.
 */
@Injectable()
export class WatchdogCronService implements OnModuleInit {
  private readonly logger = new Logger(WatchdogCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly watchdog: WatchdogService,
    private readonly config: WatchdogConfigService,
    private readonly appConfig: ConfigService,
    private readonly emailAlert: EmailAlertService,
    @InjectQueue(WATCHDOG_QUEUE) private readonly queue: Queue,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      await this.queue.add(
        WATCHDOG_FALLBACK_JOB,
        {},
        {
          repeat: { pattern: WATCHDOG_FALLBACK_PATTERN },
          jobId: 'watchdog-fallback-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log({
        msg: 'watchdog_fallback_cron_registered',
        pattern: WATCHDOG_FALLBACK_PATTERN,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to register watchdog fallback cron: ${msg}`);
    }

    // Retry diário ("toda manhã") de conversas presas — ver
    // retryStuckConversations() pro motivo de existir separado do fallback
    // de 15min (que exclui isStuck=true de propósito).
    try {
      const pattern =
        this.appConfig.get<string>('WATCHDOG_STUCK_RETRY_PATTERN') ||
        WATCHDOG_STUCK_RETRY_PATTERN_DEFAULT;
      await this.queue.add(
        WATCHDOG_STUCK_RETRY_JOB,
        {},
        {
          repeat: { pattern, tz: 'America/Sao_Paulo' },
          jobId: 'watchdog-stuck-retry-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log({
        msg: 'watchdog_stuck_retry_cron_registered',
        pattern,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(`Failed to register watchdog stuck-retry cron: ${msg}`);
    }
  }

  /**
   * Chamado pelo processor quando o repeatable dispara. Public pra
   * facilitar teste manual e invocação direta de admin endpoint.
   */
  async scanAndEnqueue(): Promise<{ scanned: number; enqueued: number }> {
    // Margem além do menor delay configurável — se org tem delayBotMin=5,
    // não queremos enfileirar conversa que ficou parada só 4min. 5min de
    // buffer evita falso positivo durante a janela do timer reativo.
    const now = new Date();
    const cutoff = new Date(now.getTime() - 5 * 60 * 1000);

    const candidates = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        isStuck: false,
        status: {
          in: [
            ConversationStatus.BOT,
            ConversationStatus.PENDING,
            ConversationStatus.OPEN,
          ],
        },
        lastMessageAt: { lt: cutoff },
        // tri-state: null ou true = OK, false = humano desligou IA
        OR: [{ aiEnabled: null }, { aiEnabled: true }],
        organization: { watchdogEnabled: true },
      },
      select: {
        id: true,
        organizationId: true,
        watchdogJobId: true,
        status: true,
        lastMessageAt: true,
      },
      take: 500, // hard cap por execução — protege contra explosão
    });

    let enqueued = 0;
    for (const conv of candidates) {
      // Confirma que a última msg é INBOUND. Se for OUTBOUND, já
      // respondemos — esse caso o cron não trata.
      const lastMsg = await this.prisma.message.findFirst({
        where: { conversationId: conv.id },
        orderBy: { createdAt: 'desc' },
        select: { direction: true },
      });
      if (!lastMsg || lastMsg.direction !== MessageDirection.INBOUND) continue;

      // Se já tem job ativo, não duplica.
      if (conv.watchdogJobId) {
        const existingJob = await this.queue.getJob(conv.watchdogJobId);
        if (existingJob) continue;
      }

      try {
        await this.watchdog.enqueueFromCron(conv.id);
        enqueued++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to enqueue watchdog from cron for conv ${conv.id}: ${msg}`,
        );
      }
    }

    if (candidates.length > 0) {
      this.logger.log(
        `Watchdog fallback scan: scanned=${candidates.length} enqueued=${enqueued}`,
      );
    }

    return { scanned: candidates.length, enqueued };
  }

  /**
   * Retry diário ("toda manhã") de conversas marcadas `isStuck=true`.
   *
   * O fallback de 15min (scanAndEnqueue) exclui `isStuck=true` DE
   * PROPÓSITO — uma conversa que já esgotou `maxAttempts` não deve ficar
   * sendo re-tentada a cada 15 minutos pra sempre (spam de tentativas
   * fracassadas se o motivo raiz for persistente, ex.: provider de IA sem
   * crédito). Mas isso também significa que, uma vez presa, uma conversa
   * NUNCA mais recebe tentativa automática — fica esperando o cliente
   * mandar mensagem nova ou um humano agir manualmente.
   *
   * Esse cron dá uma segunda chance controlada: uma vez por dia, reseta o
   * estado de presa e agenda uma nova checagem — se o motivo raiz já foi
   * resolvido (ex.: crédito recarregado), a conversa volta a responder
   * sozinha; se ainda não foi, volta a ficar presa depois de
   * `maxAttempts` de novo, sem problema (mesmo comportamento, só adiado
   * pro próximo dia).
   *
   * Achado real que motivou isso (23/08/2026): a conta de IA ficou sem
   * crédito por dias, várias conversas acumularam `isStuck=true`, e
   * mesmo depois do crédito voltar elas continuariam paradas pra sempre
   * sem esse retry.
   */
  async retryStuckConversations(): Promise<{ retried: number }> {
    const stuckConversations = await this.prisma.conversation.findMany({
      where: {
        deletedAt: null,
        isStuck: true,
        // tri-state: null ou true = OK, false = humano desligou IA de
        // propósito — não reativa contra a vontade de quem desligou.
        OR: [{ aiEnabled: null }, { aiEnabled: true }],
        organization: { watchdogEnabled: true },
      },
      select: {
        id: true,
        organizationId: true,
        contact: { select: { name: true, phone: true } },
      },
      take: 500,
    });

    if (stuckConversations.length === 0) {
      return { retried: 0 };
    }

    let retried = 0;
    for (const conv of stuckConversations) {
      try {
        await this.prisma.conversation.update({
          where: { id: conv.id },
          data: { isStuck: false, stuckAttempts: 0, watchdogJobId: null },
        });
        await this.watchdog.enqueueFromCron(conv.id);
        retried++;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(
          `Failed to retry stuck conversation ${conv.id}: ${msg}`,
        );
      }
    }

    this.logger.warn(
      `Watchdog stuck-retry: ${retried}/${stuckConversations.length} conversa(s) presa(s) receberam nova tentativa.`,
    );
    await this.notifyRetrySummary(stuckConversations, retried);

    return { retried };
  }

  private async notifyRetrySummary(
    conversations: Array<{
      id: string;
      contact: { name: string | null; phone: string | null } | null;
    }>,
    retried: number,
  ): Promise<void> {
    const to =
      this.appConfig.get<string>('WATCHDOG_STUCK_RETRY_EMAIL_TO') ||
      this.appConfig.get<string>('AI_FAILURE_ALERT_EMAIL_TO') ||
      this.appConfig.get<string>('ZAPPFY_HEALTH_ALERT_EMAIL_TO');
    if (!to) {
      this.logger.warn(
        'Nenhum e-mail de alerta configurado — resumo do retry matinal não enviado (só logado).',
      );
      return;
    }

    const names = conversations
      .slice(0, 15)
      .map((c) => c.contact?.name || c.contact?.phone || '(sem nome)')
      .map((n) => `<li>${this.escapeHtml(n)}</li>`)
      .join('');
    const extra =
      conversations.length > 15
        ? `<p>... e mais ${conversations.length - 15}.</p>`
        : '';

    await this.emailAlert.send({
      to,
      subject: `☀️ Revisão matinal — ${retried} conversa(s) presa(s) reabertas`,
      html: `
        <p>${retried} conversa(s) que estavam marcadas como "presas" (a IA travou nelas antes e desistiu de tentar de novo sozinha) receberam uma nova tentativa agora de manhã.</p>
        <p>Se o motivo raiz já foi resolvido (ex.: crédito de IA recarregado), elas devem responder sozinhas nos próximos minutos. Se continuarem paradas, vale dar uma olhada manual.</p>
        <p><b>Contatos:</b></p>
        <ul>${names}</ul>
        ${extra}
      `,
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
