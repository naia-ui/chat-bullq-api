import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ChatbotFlowsRepository } from './chatbot-flows.repository';
import { CreateChatbotFlowDto, UpdateChatbotFlowDto, ChatbotNodeDto } from './dto/create-chatbot-flow.dto';

@Injectable()
export class ChatbotFlowsService {
  constructor(private readonly repository: ChatbotFlowsRepository) {}

  async create(organizationId: string, dto: CreateChatbotFlowDto) {
    return this.repository.create({
      organizationId,
      name: dto.name,
      description: dto.description,
      triggerType: dto.triggerType || 'KEYWORD',
      triggerConfig: dto.triggerConfig || {},
    });
  }

  async findAll(organizationId: string) {
    return this.repository.findByOrg(organizationId);
  }

  async findOne(id: string, organizationId: string) {
    const flow = await this.repository.findById(id);
    if (!flow) throw new NotFoundException('Chatbot flow not found');
    if (flow.organizationId !== organizationId) throw new ForbiddenException();
    return flow;
  }

  async update(id: string, organizationId: string, dto: UpdateChatbotFlowDto) {
    await this.findOne(id, organizationId);
    return this.repository.update(id, dto);
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }

  async saveNodes(id: string, organizationId: string, nodes: ChatbotNodeDto[]) {
    await this.findOne(id, organizationId);
    return this.repository.replaceNodes(
      id,
      nodes.map((n) => ({
        type: n.type,
        name: n.name,
        positionX: n.positionX,
        positionY: n.positionY,
        data: n.data,
        edges: n.edges,
      })),
    );
  }

  async linkChannels(id: string, organizationId: string, channelIds: string[]) {
    await this.findOne(id, organizationId);
    await this.repository.setChannels(id, channelIds);
    return this.findOne(id, organizationId);
  }

  async findActiveFlowForChannel(channelId: string) {
    return this.repository.findActiveFlowForChannel(channelId);
  }
}
