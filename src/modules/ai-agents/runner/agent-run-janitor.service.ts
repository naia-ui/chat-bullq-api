import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { AiRunStatus } from '@prisma/client';

import { PrismaService } from '../../../database/prisma.service';

/**
 * Janitor de runs órfãos.
 *
 * Um `AiAgentRun` fica preso em `RUNNING` pra sempre quando o processo que o
 * executava morre no meio (deploy/restart/OOM) — o `try/catch` do runner nunca
 * roda. Isso acumula lixo e distorce métricas (visto em prod: runs presos há
 * ~49 dias).
 *
 * Estratégia (sem fila nova — só Prisma + timer):
 *  - **Boot sweep**: qualquer run em RUNNING depois de um boot é órfão, porque
 *    o processo dono não existe mais. A margem `STALE_MIN` evita matar um run
 *    legítimo em voo de OUTRA instância durante um deploy com sobreposição.
 *  - **Sweep periódico**: pega runs que travaram sem restart (ex.: hang acima
 *    do timeout do provider) e os marca FAILED.
 */
@Injectable()
export class AgentRunJanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AgentRunJanitorService.name);
  private timer: NodeJS.Timeout | null = null;

  /**
   * Acima disto, um run em RUNNING é considerado órfão. Folga generosa sobre
   * a duração máxima real de um run (MAX_TOOL_ITERATIONS × timeout do provider)
   * pra nunca matar um run legítimo, mesmo lento.
   */
  private static readonly STALE_MIN = 15;
  private static readonly SWEEP_INTERVAL_MS = 5 * 60_000;

  constructor(private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.sweep('boot');
    this.timer = setInterval(() => {
      void this.sweep('interval');
    }, AgentRunJanitorService.SWEEP_INTERVAL_MS);
    // Não segura o event loop / shutdown por causa do timer.
    this.timer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async sweep(trigger: 'boot' | 'interval'): Promise<void> {
    try {
      const cutoff = new Date(
        Date.now() - AgentRunJanitorService.STALE_MIN * 60_000,
      );
      const res = await this.prisma.aiAgentRun.updateMany({
        where: { status: AiRunStatus.RUNNING, startedAt: { lt: cutoff } },
        data: {
          status: AiRunStatus.FAILED,
          errorMessage:
            'Run órfão: processo encerrado ou travou sem finalizar (janitor).',
          finishedAt: new Date(),
        },
      });
      if (res.count > 0) {
        this.logger.warn(
          `[janitor:${trigger}] ${res.count} run(s) órfão(s) marcados como FAILED`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `[janitor:${trigger}] sweep falhou: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}
