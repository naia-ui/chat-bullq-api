import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';

export interface DateRange {
  from: Date;
  to: Date;
}

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(organizationId: string, range: DateRange) {
    const where = { organizationId, createdAt: { gte: range.from, lte: range.to } };
    const prevFrom = new Date(range.from.getTime() - (range.to.getTime() - range.from.getTime()));
    const prevWhere = { organizationId, createdAt: { gte: prevFrom, lte: range.from } };

    const [totalConversations, prevTotal, openConversations, pendingConversations, totalMessages, prevMessages] =
      await this.prisma.$transaction([
        this.prisma.conversation.count({ where }),
        this.prisma.conversation.count({ where: prevWhere }),
        this.prisma.conversation.count({ where: { organizationId, status: 'OPEN' } }),
        this.prisma.conversation.count({ where: { organizationId, status: 'PENDING' } }),
        this.prisma.message.count({ where: { conversation: { organizationId }, createdAt: { gte: range.from, lte: range.to } } }),
        this.prisma.message.count({ where: { conversation: { organizationId }, createdAt: { gte: prevFrom, lte: range.from } } }),
      ]);

    const avgFirstResponse = await this.getAvgFirstResponseTime(organizationId, range);
    const avgResolution = await this.getAvgResolutionTime(organizationId, range);
    const slaCompliance = await this.getSlaCompliance(organizationId, range);

    return {
      totalConversations,
      conversationsTrend: this.calcTrend(totalConversations, prevTotal),
      openConversations,
      pendingConversations,
      totalMessages,
      messagesTrend: this.calcTrend(totalMessages, prevMessages),
      avgFirstResponseMinutes: avgFirstResponse,
      avgResolutionMinutes: avgResolution,
      slaCompliancePercent: slaCompliance,
    };
  }

  async getVolumeByDay(organizationId: string, range: DateRange) {
    const conversations = await this.prisma.conversation.findMany({
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      select: { createdAt: true },
    });

    const byDay = new Map<string, number>();
    for (const c of conversations) {
      const day = c.createdAt.toISOString().slice(0, 10);
      byDay.set(day, (byDay.get(day) || 0) + 1);
    }

    return Array.from(byDay.entries())
      .map(([date, count]) => ({ date, count }))
      .sort((a, b) => a.date.localeCompare(b.date));
  }

  async getVolumeByChannel(organizationId: string, range: DateRange) {
    const result = await this.prisma.conversation.groupBy({
      by: ['channelId'],
      where: { organizationId, createdAt: { gte: range.from, lte: range.to } },
      _count: true,
    });

    const channels = await this.prisma.channel.findMany({
      where: { organizationId },
      select: { id: true, name: true, type: true },
    });

    return result.map((r) => {
      const ch = channels.find((c) => c.id === r.channelId);
      return { channelId: r.channelId, channelName: ch?.name || 'Unknown', channelType: ch?.type, count: r._count };
    });
  }

  async getVolumeByStatus(organizationId: string) {
    const result = await this.prisma.conversation.groupBy({
      by: ['status'],
      where: { organizationId },
      _count: true,
    });
    return result.map((r) => ({ status: r.status, count: r._count }));
  }

  async getAgentPerformance(organizationId: string, range: DateRange) {
    const conversations = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        assignedToId: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: {
        assignedToId: true,
        status: true,
        firstResponseAt: true,
        closedAt: true,
        createdAt: true,
        assignedTo: { select: { id: true, name: true, avatarUrl: true } },
      },
    });

    const agentMap = new Map<string, {
      agent: { id: string; name: string; avatarUrl: string | null };
      total: number;
      closed: number;
      responseTimes: number[];
    }>();

    for (const c of conversations) {
      if (!c.assignedToId || !c.assignedTo) continue;
      if (!agentMap.has(c.assignedToId)) {
        agentMap.set(c.assignedToId, { agent: c.assignedTo, total: 0, closed: 0, responseTimes: [] });
      }
      const a = agentMap.get(c.assignedToId)!;
      a.total++;
      if (c.status === 'CLOSED') a.closed++;
      if (c.firstResponseAt) {
        a.responseTimes.push((c.firstResponseAt.getTime() - c.createdAt.getTime()) / 60000);
      }
    }

    return Array.from(agentMap.values()).map((a) => ({
      agent: a.agent,
      totalConversations: a.total,
      closedConversations: a.closed,
      avgFirstResponseMinutes: a.responseTimes.length
        ? Math.round(a.responseTimes.reduce((s, v) => s + v, 0) / a.responseTimes.length)
        : null,
    }));
  }

  private async getAvgFirstResponseTime(organizationId: string, range: DateRange): Promise<number | null> {
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        firstResponseAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, firstResponseAt: true },
    });
    if (convs.length === 0) return null;
    const total = convs.reduce((s, c) => s + (c.firstResponseAt!.getTime() - c.createdAt.getTime()), 0);
    return Math.round(total / convs.length / 60000);
  }

  private async getAvgResolutionTime(organizationId: string, range: DateRange): Promise<number | null> {
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        closedAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, closedAt: true },
    });
    if (convs.length === 0) return null;
    const total = convs.reduce((s, c) => s + (c.closedAt!.getTime() - c.createdAt.getTime()), 0);
    return Math.round(total / convs.length / 60000);
  }

  private async getSlaCompliance(organizationId: string, range: DateRange): Promise<number | null> {
    const dept = await this.prisma.department.findFirst({
      where: { organizationId, isDefault: true },
      select: { slaFirstResponse: true },
    });
    if (!dept?.slaFirstResponse) return null;

    const slaMinutes = dept.slaFirstResponse;
    const convs = await this.prisma.conversation.findMany({
      where: {
        organizationId,
        firstResponseAt: { not: null },
        createdAt: { gte: range.from, lte: range.to },
      },
      select: { createdAt: true, firstResponseAt: true },
    });
    if (convs.length === 0) return null;

    const withinSla = convs.filter(
      (c) => (c.firstResponseAt!.getTime() - c.createdAt.getTime()) / 60000 <= slaMinutes,
    ).length;

    return Math.round((withinSla / convs.length) * 100);
  }

  private calcTrend(current: number, previous: number): number {
    if (previous === 0) return current > 0 ? 100 : 0;
    return Math.round(((current - previous) / previous) * 100);
  }
}
