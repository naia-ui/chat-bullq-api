import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AiAgentMode, AiAgentTrigger } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';
import { CreateAgentDto } from './dto/create-agent.dto';
import { UpdateAgentDto } from './dto/update-agent.dto';
import { AssignAgentChannelDto } from './dto/assign-channel.dto';

@Injectable()
export class AgentsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(organizationId: string, dto: CreateAgentDto) {
    if (dto.parentAgentId) {
      await this.assertParentExists(organizationId, dto.parentAgentId);
    }
    const agent = await this.prisma.aiAgent.create({
      data: {
        organizationId,
        name: dto.name,
        description: dto.description,
        avatarUrl: dto.avatarUrl,
        kind: dto.kind ?? 'WORKER',
        category: dto.category,
        capabilities: dto.capabilities ?? [],
        modelId: dto.modelId,
        modelParams: dto.modelParams as object | undefined,
        systemPrompt: dto.systemPrompt,
        temperature: dto.temperature ?? 0.7,
        maxTokens: dto.maxTokens ?? 2048,
        canRespondDirectly: dto.canRespondDirectly ?? true,
        isActive: dto.isActive ?? true,
        parentAgentId: dto.parentAgentId ?? null,
        department: dto.department ?? null,
        squad: dto.squad ?? null,
        operationalContext: dto.operationalContext ?? null,
        operationalContextUpdatedAt: dto.operationalContext ? new Date() : null,
      },
    });

    // Auto-link a TODOS os canais ativos da org com mode AUTONOMOUS.
    // Justificativa: criar agent sem canal = agent inerte (não responde
    // ninguém). 99% dos casos JP quer o agent ativo em tudo, e
    // específicos podem ser desligados depois manualmente. Default
    // útil > default vazio.
    const channels = await this.prisma.channel.findMany({
      where: { organizationId, isActive: true, deletedAt: null },
      select: { id: true },
    });
    if (channels.length > 0) {
      await this.prisma.aiAgentChannel.createMany({
        data: channels.map((c) => ({
          agentId: agent.id,
          channelId: c.id,
          mode: 'AUTONOMOUS' as const,
          trigger: 'ALWAYS' as const,
        })),
        skipDuplicates: true,
      });
    }
    return agent;
  }

  async list(organizationId: string) {
    return this.prisma.aiAgent.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ kind: 'asc' }, { createdAt: 'asc' }],
      include: {
        channels: {
          include: {
            channel: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
  }

  async findOne(organizationId: string, id: string) {
    const agent = await this.prisma.aiAgent.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        channels: {
          include: {
            channel: { select: { id: true, name: true, type: true } },
          },
        },
      },
    });
    if (!agent) throw new NotFoundException('Agent not found');
    return agent;
  }

  async update(organizationId: string, id: string, dto: UpdateAgentDto) {
    const existing = await this.findOne(organizationId, id);

    // Validate org-tree integrity when changing parent.
    // Two failure modes: (a) self-reference, (b) cycle via descendant.
    if (dto.parentAgentId !== undefined && dto.parentAgentId !== null) {
      if (dto.parentAgentId === id) {
        throw new BadRequestException(
          'Um agent não pode reportar a si mesmo',
        );
      }
      await this.assertParentExists(organizationId, dto.parentAgentId);
      const wouldCycle = await this.isDescendantOf(
        organizationId,
        dto.parentAgentId,
        id,
      );
      if (wouldCycle) {
        throw new BadRequestException(
          'Hierarquia inválida: o agent escolhido como chefe é subordinado deste agent (criaria um ciclo)',
        );
      }
    }

    // Touch operationalContextUpdatedAt apenas quando o conteúdo mudou de
    // verdade. Se o cliente reenvia o mesmo texto (ex: salvou outros
    // campos), não bombardeia o "atualizado em" — operador vai confiar
    // nesse timestamp pra saber se a memória ainda tá viva.
    const operationalContextChanged =
      dto.operationalContext !== undefined &&
      dto.operationalContext !== (existing as any).operationalContext;

    return this.prisma.aiAgent.update({
      where: { id },
      data: {
        ...dto,
        modelParams: dto.modelParams as object | undefined,
        ...(operationalContextChanged
          ? { operationalContextUpdatedAt: new Date() }
          : {}),
      },
    });
  }

  /** Verifies a candidate parent exists in the same org and isn't soft-deleted. */
  private async assertParentExists(organizationId: string, parentId: string) {
    const parent = await this.prisma.aiAgent.findFirst({
      where: { id: parentId, organizationId, deletedAt: null },
      select: { id: true },
    });
    if (!parent) {
      throw new BadRequestException(
        'Agent escolhido como chefe não foi encontrado nesta organização',
      );
    }
  }

  /**
   * Walks `candidateId`'s ancestor chain to see if `ancestorId` appears.
   * Used to block cycles when reassigning a parent — if the new parent is
   * already a descendant of the agent being edited, the assignment would
   * close a loop.
   */
  private async isDescendantOf(
    organizationId: string,
    candidateId: string,
    ancestorId: string,
  ): Promise<boolean> {
    let cursor: string | null = candidateId;
    const visited = new Set<string>();
    // bounded loop — depth cap protects against unexpected DB cycles.
    for (let depth = 0; depth < 50 && cursor; depth++) {
      if (visited.has(cursor)) return false;
      visited.add(cursor);
      const node: { parentAgentId: string | null } | null =
        await this.prisma.aiAgent.findFirst({
          where: { id: cursor, organizationId, deletedAt: null },
          select: { parentAgentId: true },
        });
      if (!node?.parentAgentId) return false;
      if (node.parentAgentId === ancestorId) return true;
      cursor = node.parentAgentId;
    }
    return false;
  }

  async softDelete(organizationId: string, id: string) {
    await this.findOne(organizationId, id);
    await this.prisma.aiAgent.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async assignChannel(
    organizationId: string,
    agentId: string,
    dto: AssignAgentChannelDto,
  ) {
    await this.findOne(organizationId, agentId);

    const channel = await this.prisma.channel.findFirst({
      where: { id: dto.channelId, organizationId, deletedAt: null },
    });
    if (!channel) {
      throw new BadRequestException('Channel not found in this organization');
    }

    return this.prisma.aiAgentChannel.upsert({
      where: {
        agentId_channelId: { agentId, channelId: dto.channelId },
      },
      update: {
        mode: dto.mode ?? AiAgentMode.AUTONOMOUS,
        trigger: dto.trigger ?? AiAgentTrigger.ALWAYS,
      },
      create: {
        agentId,
        channelId: dto.channelId,
        mode: dto.mode ?? AiAgentMode.AUTONOMOUS,
        trigger: dto.trigger ?? AiAgentTrigger.ALWAYS,
      },
    });
  }

  async unassignChannel(
    organizationId: string,
    agentId: string,
    channelId: string,
  ) {
    await this.findOne(organizationId, agentId);
    await this.prisma.aiAgentChannel.deleteMany({
      where: { agentId, channelId },
    });
  }

  async listRuns(organizationId: string, agentId: string, limit = 50) {
    await this.findOne(organizationId, agentId);
    return this.prisma.aiAgentRun.findMany({
      where: { agentId, organizationId },
      orderBy: { startedAt: 'desc' },
      take: limit,
      include: { toolCalls: true },
    });
  }

  // ─── Jarvis stats ─────────────────────────────────────────────

  /**
   * Returns org-wide aggregates over a time window: total runs, success/fail
   * counts, costs, tokens, latency p50/p95, breakdowns by model, tool, and
   * handoff. Used by the "Visão Geral" tab.
   */
  async getOrgStats(organizationId: string, period: '24h' | '7d' | '30d') {
    const since = this.windowStart(period);

    const [
      runs,
      monthlyTokensUsed,
      org,
      toolStats,
      handoffStats,
    ] = await Promise.all([
      this.prisma.aiAgentRun.findMany({
        where: { organizationId, startedAt: { gte: since } },
        select: {
          id: true,
          agentId: true,
          modelId: true,
          status: true,
          finalAction: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          costUsd: true,
          durationMs: true,
        },
      }),
      this.aggregateMonthlyTokens(organizationId),
      this.prisma.organization.findUnique({
        where: { id: organizationId },
        select: { aiMonthlyTokenCap: true },
      }),
      this.prisma.aiToolCall.groupBy({
        by: ['toolName'],
        where: { run: { organizationId, startedAt: { gte: since } } },
        _count: { _all: true },
      }),
      this.prisma.aiAgentHandoff.findMany({
        where: {
          conversation: { organizationId },
          createdAt: { gte: since },
        },
        select: { fromAgentId: true, toAgentId: true },
      }),
    ]);

    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'COMPLETED').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const skipped = runs.filter((r) => r.status === 'SKIPPED').length;

    const inputTokens = sum(runs, (r) => r.inputTokens);
    const outputTokens = sum(runs, (r) => r.outputTokens);
    const cacheReadTokens = sum(runs, (r) => r.cacheReadTokens);
    const cacheWriteTokens = sum(runs, (r) => r.cacheWriteTokens);
    const costUsd = runs.reduce(
      (acc, r) => acc + Number(r.costUsd || 0),
      0,
    );

    const durations = runs
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);

    const byModel = groupSum(runs, (r) => r.modelId, (r) => ({
      runs: 1,
      tokens: r.inputTokens + r.outputTokens,
      cost: Number(r.costUsd || 0),
    }));

    const byFinalAction = groupCount(runs, (r) => r.finalAction || 'NONE');
    const byAgent = groupSum(runs, (r) => r.agentId, (r) => ({
      runs: 1,
      tokens: r.inputTokens + r.outputTokens,
      cost: Number(r.costUsd || 0),
    }));

    const handoffPairs = groupCount(
      handoffStats,
      (h) => `${h.fromAgentId ?? 'system'}::${h.toAgentId}`,
    );

    return {
      period,
      since: since.toISOString(),
      runs: {
        total,
        completed,
        failed,
        skipped,
        successRate:
          total > 0 ? +((completed / total) * 100).toFixed(1) : null,
      },
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: cacheReadTokens,
        cacheWrite: cacheWriteTokens,
        total: inputTokens + outputTokens,
      },
      cost: {
        usd: +costUsd.toFixed(4),
        avgPerRun: total > 0 ? +(costUsd / total).toFixed(6) : 0,
      },
      latency: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
      monthlyCap: {
        used: monthlyTokensUsed,
        cap: org?.aiMonthlyTokenCap ?? null,
        percentUsed:
          org?.aiMonthlyTokenCap && org.aiMonthlyTokenCap > 0
            ? +((monthlyTokensUsed / org.aiMonthlyTokenCap) * 100).toFixed(1)
            : null,
      },
      byModel: Object.entries(byModel).map(([modelId, v]) => ({
        modelId,
        ...v,
      })),
      byAgent: Object.entries(byAgent).map(([agentId, v]) => ({
        agentId,
        ...v,
      })),
      byFinalAction,
      tools: toolStats.map((t) => ({
        name: t.toolName,
        calls: t._count._all,
      })),
      handoffs: Object.entries(handoffPairs).map(([key, count]) => {
        const [fromAgentId, toAgentId] = key.split('::');
        return { fromAgentId, toAgentId, count };
      }),
    };
  }

  /** Single-agent stats with the same shape (minus byAgent breakdown). */
  async getAgentStats(
    organizationId: string,
    agentId: string,
    period: '24h' | '7d' | '30d',
  ) {
    await this.findOne(organizationId, agentId);
    const since = this.windowStart(period);

    const [runs, toolStats, handoffsOut, handoffsIn] = await Promise.all([
      this.prisma.aiAgentRun.findMany({
        where: { organizationId, agentId, startedAt: { gte: since } },
        select: {
          modelId: true,
          status: true,
          finalAction: true,
          inputTokens: true,
          outputTokens: true,
          cacheReadTokens: true,
          cacheWriteTokens: true,
          costUsd: true,
          durationMs: true,
        },
      }),
      this.prisma.aiToolCall.groupBy({
        by: ['toolName'],
        where: {
          run: { organizationId, agentId, startedAt: { gte: since } },
        },
        _count: { _all: true },
      }),
      this.prisma.aiAgentHandoff.count({
        where: {
          fromAgentId: agentId,
          createdAt: { gte: since },
        },
      }),
      this.prisma.aiAgentHandoff.count({
        where: {
          toAgentId: agentId,
          fromAgentId: { not: agentId },
          createdAt: { gte: since },
        },
      }),
    ]);

    const total = runs.length;
    const completed = runs.filter((r) => r.status === 'COMPLETED').length;
    const failed = runs.filter((r) => r.status === 'FAILED').length;
    const inputTokens = sum(runs, (r) => r.inputTokens);
    const outputTokens = sum(runs, (r) => r.outputTokens);
    const costUsd = runs.reduce((a, r) => a + Number(r.costUsd || 0), 0);
    const durations = runs
      .map((r) => r.durationMs)
      .filter((d): d is number => typeof d === 'number')
      .sort((a, b) => a - b);

    return {
      period,
      since: since.toISOString(),
      runs: {
        total,
        completed,
        failed,
        successRate:
          total > 0 ? +((completed / total) * 100).toFixed(1) : null,
      },
      tokens: {
        input: inputTokens,
        output: outputTokens,
        cacheRead: sum(runs, (r) => r.cacheReadTokens),
        cacheWrite: sum(runs, (r) => r.cacheWriteTokens),
        total: inputTokens + outputTokens,
      },
      cost: {
        usd: +costUsd.toFixed(4),
        avgPerRun: total > 0 ? +(costUsd / total).toFixed(6) : 0,
      },
      latency: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
      byFinalAction: groupCount(runs, (r) => r.finalAction || 'NONE'),
      byModel: Object.entries(
        groupSum(runs, (r) => r.modelId, (r) => ({
          runs: 1,
          tokens: r.inputTokens + r.outputTokens,
          cost: Number(r.costUsd || 0),
        })),
      ).map(([modelId, v]) => ({ modelId, ...v })),
      tools: toolStats.map((t) => ({
        name: t.toolName,
        calls: t._count._all,
      })),
      handoffs: { sent: handoffsOut, received: handoffsIn },
    };
  }

  /**
   * Run feed for the org with rich filters used by the "Execuções" tab.
   * Returns each run with its tool calls (full input/output/error) so the
   * UI can flag silent failures — tools that returned ok:false or status>=400
   * even when the catch-block error column is null.
   */
  async listOrgRuns(
    organizationId: string,
    options: {
      agentId?: string;
      period?: '24h' | '7d' | '30d' | 'all';
      hasErrors?: boolean;
      status?: 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED';
      finalAction?: string;
      limit?: number;
      cursor?: string;
    },
  ) {
    const since =
      options.period && options.period !== 'all'
        ? this.windowStart(options.period)
        : undefined;

    const runs = await this.prisma.aiAgentRun.findMany({
      where: {
        organizationId,
        ...(options.agentId ? { agentId: options.agentId } : {}),
        ...(since ? { startedAt: { gte: since } } : {}),
        ...(options.status ? { status: options.status } : {}),
        ...(options.finalAction
          ? options.finalAction === 'NONE'
            ? { finalAction: null }
            : { finalAction: options.finalAction as any }
          : {}),
      },
      orderBy: { startedAt: 'desc' },
      take: Math.min(options.limit ?? 50, 200),
      ...(options.cursor
        ? { cursor: { id: options.cursor }, skip: 1 }
        : {}),
      include: {
        agent: { select: { id: true, name: true, kind: true } },
        toolCalls: {
          select: {
            id: true,
            toolName: true,
            input: true,
            output: true,
            error: true,
            durationMs: true,
            createdAt: true,
          },
          orderBy: { createdAt: 'asc' },
        },
      },
    });

    // Compute hasFailedToolCall flag client-side and optionally drop runs
    // without failures when the user filtered for "só com erros".
    const enriched = runs.map((r) => ({
      ...r,
      failedToolCalls: r.toolCalls.filter((tc) => isToolCallFailure(tc)).length,
      hasFailedToolCalls: r.toolCalls.some((tc) => isToolCallFailure(tc)),
    }));

    if (options.hasErrors) {
      return enriched.filter(
        (r) => r.hasFailedToolCalls || r.status === 'FAILED',
      );
    }
    return enriched;
  }

  // ─── private helpers ────────────────────────────────────────────

  private windowStart(period: '24h' | '7d' | '30d'): Date {
    const now = new Date();
    const ms = { '24h': 86400, '7d': 604800, '30d': 2592000 }[period] * 1000;
    return new Date(now.getTime() - ms);
  }

  private async aggregateMonthlyTokens(organizationId: string) {
    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);
    const agg = await this.prisma.aiAgentRun.aggregate({
      where: { organizationId, startedAt: { gte: startOfMonth } },
      _sum: { inputTokens: true, outputTokens: true },
    });
    return (agg._sum.inputTokens ?? 0) + (agg._sum.outputTokens ?? 0);
  }
}

// ─── pure helpers (top-level) ─────────────────────────────────────

function sum<T>(arr: T[], pick: (item: T) => number): number {
  return arr.reduce((acc, item) => acc + (pick(item) || 0), 0);
}

function groupCount<T>(arr: T[], key: (item: T) => string) {
  const out: Record<string, number> = {};
  for (const item of arr) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

function groupSum<T, V extends Record<string, number>>(
  arr: T[],
  key: (item: T) => string,
  pick: (item: T) => V,
): Record<string, V> {
  const out: Record<string, V> = {};
  for (const item of arr) {
    const k = key(item);
    const v = pick(item);
    if (!out[k]) {
      out[k] = { ...v };
    } else {
      for (const field in v) {
        out[k][field] = ((out[k][field] || 0) + (v[field] || 0)) as V[typeof field];
      }
    }
  }
  return out;
}

function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const idx = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[idx];
}

/**
 * A tool call is considered failed if either:
 *   1. the executor caught an exception (error != null), or
 *   2. the output JSON signals a logical failure — `ok:false` or
 *      `status >= 400`. HTTP/SQL custom skills return shapes like
 *      `{ ok: true | false, body, status }` and a 404 from the upstream
 *      API does NOT throw, so the catch-block error column stays null.
 *      Without checking the output shape we'd miss the very class of
 *      failures the UI exists to surface.
 */
export function isToolCallFailure(tc: {
  error: string | null;
  output: unknown;
}): boolean {
  if (tc.error) return true;
  const out = tc.output as Record<string, any> | null;
  if (!out || typeof out !== 'object') return false;
  if (out.ok === false) return true;
  const status = Number(out.status);
  if (Number.isFinite(status) && status >= 400) return true;
  return false;
}
