import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { EmailAlertService } from '../../notifications/email-alert.service';
import {
  AI_FAILURE_ALERT_COOLDOWN_MINUTES_DEFAULT,
  AI_FAILURE_MIN_RUNS_DEFAULT,
  AI_FAILURE_WINDOW_MINUTES_DEFAULT,
  AI_RUN_HEALTH_CHECK_PATTERN_DEFAULT,
  AI_RUN_HEALTH_JOB,
  AI_RUN_HEALTH_QUEUE,
} from './ai-run-health.constants';

/**
 * Monitora proativamente se as execuções de IA estão de fato funcionando —
 * não só se o processo está de pé (health check HTTP não pega isso: a API
 * responde normal, o problema é *dentro* do run, ex. provider sem crédito).
 *
 * Motivado por um achado real (22/08/2026): a conta da Anthropic ficou sem
 * crédito e 100% das execuções de IA falharam por pelo menos 5 dias sem
 * ninguém perceber — não existia nenhum alerta equivalente ao que já existe
 * pra conexão do WhatsApp cair. Esse cron fecha exatamente essa lacuna.
 *
 * Lógica: pega os runs mais recentes de cada org numa janela de tempo; se
 * teve volume suficiente pra concluir algo E todos falharam, alerta por
 * e-mail com o erro do run mais recente (o motivo real já vem pronto —
 * "credit balance too low", timeout, etc. — sem precisar caçar log).
 */
@Processor(AI_RUN_HEALTH_QUEUE, { concurrency: 1 })
export class AiRunHealthCron extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(AiRunHealthCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailAlert: EmailAlertService,
    private readonly config: ConfigService,
    @InjectQueue(AI_RUN_HEALTH_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const pattern =
      this.config.get<string>('AI_RUN_HEALTH_CHECK_PATTERN') ||
      AI_RUN_HEALTH_CHECK_PATTERN_DEFAULT;
    try {
      await this.queue.add(
        AI_RUN_HEALTH_JOB,
        {},
        {
          repeat: { pattern },
          jobId: 'ai-run-health-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`ai_run_health_cron_registered pattern=${pattern}`);
    } catch (err) {
      this.logger.error(
        `Falha registrando cron de saúde das execuções de IA: ${(err as Error).message}`,
      );
    }
  }

  async process(_job: Job): Promise<{ orgsChecked: number; failing: number }> {
    const orgs = await this.prisma.organization.findMany({
      where: { aiEnabled: true },
      select: {
        id: true,
        name: true,
        aiFailureStreakSince: true,
        aiFailureAlertLastSentAt: true,
      },
    });

    let failing = 0;
    for (const org of orgs) {
      try {
        const isFailing = await this.checkOrg(org);
        if (isFailing) failing++;
      } catch (err: any) {
        // Erro ao checar (ex.: falha transiente de DB) não é prova de
        // execuções falhando — só loga e segue pra próxima org, não marca
        // como failing (evita falso-positivo por instabilidade da própria
        // checagem em vez do que ela mede).
        this.logger.error(
          `Falha ao checar saúde de execuções da org ${org.id}: ${err?.message ?? err}`,
        );
      }
    }
    if (failing > 0) {
      this.logger.warn(`AI run health: ${failing}/${orgs.length} org(s) com execuções falhando.`);
    }
    return { orgsChecked: orgs.length, failing };
  }

  /** Retorna true se a org está numa sequência de falha confirmada agora. */
  private async checkOrg(org: {
    id: string;
    name: string;
    aiFailureStreakSince: Date | null;
    aiFailureAlertLastSentAt: Date | null;
  }): Promise<boolean> {
    const windowMinutes = Number(
      this.config.get('AI_FAILURE_WINDOW_MINUTES') ??
        AI_FAILURE_WINDOW_MINUTES_DEFAULT,
    );
    const minRuns = Number(
      this.config.get('AI_FAILURE_MIN_RUNS') ?? AI_FAILURE_MIN_RUNS_DEFAULT,
    );
    const windowStart = new Date(Date.now() - windowMinutes * 60 * 1000);

    const recentRuns = await this.prisma.aiAgentRun.findMany({
      where: { organizationId: org.id, startedAt: { gte: windowStart } },
      orderBy: { startedAt: 'desc' },
      take: 20,
      select: {
        status: true,
        errorMessage: true,
        modelId: true,
        startedAt: true,
        agent: { select: { name: true } },
      },
    });

    // Volume insuficiente pra concluir qualquer coisa (ex.: madrugada
    // parada) — não é indício de problema, é ausência de dado.
    if (recentRuns.length < minRuns) {
      return false;
    }

    const allFailed = recentRuns.every((r) => r.status === 'FAILED');

    if (!allFailed) {
      if (org.aiFailureStreakSince) {
        await this.notifyRecovered(org);
      }
      return false;
    }

    // Sequência de falha confirmada.
    const cooldownMinutes = Number(
      this.config.get('AI_FAILURE_ALERT_COOLDOWN_MINUTES') ??
        AI_FAILURE_ALERT_COOLDOWN_MINUTES_DEFAULT,
    );
    const dueForAlert =
      !org.aiFailureAlertLastSentAt ||
      Date.now() - org.aiFailureAlertLastSentAt.getTime() >=
        cooldownMinutes * 60 * 1000;

    if (dueForAlert) {
      await this.notifyFailing(org, recentRuns);
      await this.prisma.organization.update({
        where: { id: org.id },
        data: {
          aiFailureStreakSince: org.aiFailureStreakSince ?? new Date(),
          aiFailureAlertLastSentAt: new Date(),
        },
      });
    } else if (!org.aiFailureStreakSince) {
      // Primeira detecção dentro do cooldown de outro alerta (não deveria
      // acontecer na prática, mas garante o watermark existir de qualquer
      // forma pra notifyRecovered() funcionar depois).
      await this.prisma.organization.update({
        where: { id: org.id },
        data: { aiFailureStreakSince: new Date() },
      });
    }

    return true;
  }

  private async notifyFailing(
    org: { id: string; name: string },
    recentRuns: Array<{
      status: string;
      errorMessage: string | null;
      modelId: string;
      startedAt: Date;
      agent: { name: string } | null;
    }>,
  ): Promise<void> {
    const to =
      this.config.get<string>('AI_FAILURE_ALERT_EMAIL_TO') ||
      this.config.get<string>('ZAPPFY_HEALTH_ALERT_EMAIL_TO');
    if (!to) {
      this.logger.warn(
        `Org ${org.id} (${org.name}) com execuções de IA falhando, mas AI_FAILURE_ALERT_EMAIL_TO não configurado — sem e-mail enviado.`,
      );
      return;
    }

    const latest = recentRuns[0];
    const errorLine = latest?.errorMessage
      ? this.escapeHtml(latest.errorMessage)
      : '(sem mensagem de erro registrada)';

    await this.emailAlert.send({
      to,
      subject: `🔴 IA não está respondendo — ${org.name}`,
      html: `
        <p><b>${recentRuns.length} de ${recentRuns.length} execuções recentes falharam</b> na organização "${this.escapeHtml(org.name)}".</p>
        <p><b>Erro mais recente</b> (agente "${this.escapeHtml(latest?.agent?.name ?? '?')}", modelo <code>${this.escapeHtml(latest?.modelId ?? '?')}</code>):</p>
        <p style="background:#fdeae1;border-radius:6px;padding:10px 14px;font-family:monospace;font-size:13px;">${errorLine}</p>
        <p>Isso normalmente é crédito esgotado no provider de IA (Anthropic/OpenAI/Gemini) — confere o billing do provider correspondente ao modelo acima.</p>
        <p style="color:#888;font-size:12px">Enquanto isso continuar, nenhum lead está recebendo resposta automática.</p>
      `,
    });
    this.logger.warn(
      `Org ${org.id} (${org.name}) com execuções de IA falhando — alerta disparado para ${to}.`,
    );
  }

  private async notifyRecovered(org: { id: string; name: string; aiFailureStreakSince: Date | null }): Promise<void> {
    const to =
      this.config.get<string>('AI_FAILURE_ALERT_EMAIL_TO') ||
      this.config.get<string>('ZAPPFY_HEALTH_ALERT_EMAIL_TO');

    const downSince = org.aiFailureStreakSince;
    const durationMin = downSince
      ? Math.round((Date.now() - downSince.getTime()) / 60000)
      : undefined;

    if (to) {
      await this.emailAlert.send({
        to,
        subject: `✅ IA voltou a funcionar — ${org.name}`,
        html: `
          <p>As execuções de IA da organização "${this.escapeHtml(org.name)}" voltaram a completar normalmente.</p>
          ${durationMin !== undefined ? `<p>Ficou falhando por aproximadamente ${durationMin} minuto(s).</p>` : ''}
        `,
      });
    }

    await this.prisma.organization.update({
      where: { id: org.id },
      data: { aiFailureStreakSince: null, aiFailureAlertLastSentAt: null },
    });
    this.logger.log(`Org ${org.id} (${org.name}) — execuções de IA recuperadas.`);
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
