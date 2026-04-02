import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../database/prisma.service';

@Injectable()
export class ChatbotFlowsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(data: Prisma.ChatbotFlowUncheckedCreateInput) {
    return this.prisma.chatbotFlow.create({ data });
  }

  async findByOrg(organizationId: string) {
    return this.prisma.chatbotFlow.findMany({
      where: { organizationId, deletedAt: null },
      include: {
        nodes: { orderBy: { createdAt: 'asc' } },
        channels: { include: { channel: { select: { id: true, name: true, type: true } } } },
        _count: { select: { nodes: true } },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findById(id: string) {
    return this.prisma.chatbotFlow.findFirst({
      where: { id, deletedAt: null },
      include: {
        nodes: { orderBy: { createdAt: 'asc' } },
        channels: { include: { channel: { select: { id: true, name: true, type: true } } } },
      },
    });
  }

  async update(id: string, data: Prisma.ChatbotFlowUpdateInput) {
    return this.prisma.chatbotFlow.update({ where: { id }, data });
  }

  async softDelete(id: string) {
    return this.prisma.chatbotFlow.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async replaceNodes(
    flowId: string,
    nodes: { type: string; name?: string; positionX: number; positionY: number; data: any; edges: any }[],
  ) {
    await this.prisma.chatbotNode.deleteMany({ where: { flowId } });
    if (nodes.length === 0) return [];

    return this.prisma.$transaction(
      nodes.map((n) =>
        this.prisma.chatbotNode.create({
          data: { flowId, type: n.type as any, name: n.name, positionX: n.positionX, positionY: n.positionY, data: n.data, edges: n.edges },
        }),
      ),
    );
  }

  async setChannels(flowId: string, channelIds: string[]) {
    await this.prisma.chatbotFlowChannel.deleteMany({ where: { flowId } });
    if (channelIds.length === 0) return;
    await this.prisma.chatbotFlowChannel.createMany({
      data: channelIds.map((channelId) => ({ flowId, channelId })),
    });
  }

  async findActiveFlowForChannel(channelId: string) {
    const link = await this.prisma.chatbotFlowChannel.findFirst({
      where: {
        channelId,
        flow: { isActive: true, deletedAt: null },
      },
      include: {
        flow: { include: { nodes: true } },
      },
    });
    return link?.flow || null;
  }
}
