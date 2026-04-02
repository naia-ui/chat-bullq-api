import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { ConversationStatus } from '@prisma/client';
import { ConversationsRepository, InboxFilters } from './conversations.repository';
import { ConversationFsmService } from './conversation-fsm.service';
import { UpdateConversationDto } from './dto/update-conversation.dto';

@Injectable()
export class ConversationsService {
  constructor(
    private readonly repository: ConversationsRepository,
    private readonly fsm: ConversationFsmService,
  ) {}

  async findInbox(
    organizationId: string,
    filters: {
      status?: string;
      channelId?: string;
      assignedToId?: string;
      search?: string;
    },
    page: number,
    limit: number,
  ) {
    const validStatuses = new Set(Object.values(ConversationStatus));
    const parsedStatuses = filters.status
      ?.split(',')
      .map((s) => s.trim() as ConversationStatus)
      .filter((s) => validStatuses.has(s));

    const inboxFilters: InboxFilters = {
      organizationId,
      status: parsedStatuses?.length ? parsedStatuses : undefined,
      channelId: filters.channelId,
      assignedToId: filters.assignedToId,
      search: filters.search,
    };

    const skip = (page - 1) * limit;
    const { conversations, total } = await this.repository.findInbox(
      inboxFilters,
      skip,
      limit,
    );

    return {
      conversations,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  }

  async findOne(id: string, organizationId: string) {
    const conversation = await this.repository.findById(id);
    if (!conversation) throw new NotFoundException('Conversation not found');
    if (conversation.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    return conversation;
  }

  async update(
    id: string,
    organizationId: string,
    dto: UpdateConversationDto,
    actorId: string,
  ) {
    const conversation = await this.findOne(id, organizationId);

    if (dto.assignedToId) {
      await this.fsm.assign(id, dto.assignedToId, actorId);
    }

    if (dto.status && dto.status !== conversation.status) {
      await this.fsm.transition(id, dto.status, actorId);
    }

    if (dto.departmentId) {
      await this.repository.update(id, { department: { connect: { id: dto.departmentId } } });
    }

    return this.repository.findById(id);
  }

  async close(id: string, organizationId: string, actorId: string) {
    await this.findOne(id, organizationId);
    await this.fsm.transition(id, ConversationStatus.CLOSED, actorId);
    return this.repository.findById(id);
  }

  async reopen(id: string, organizationId: string, actorId: string) {
    const conversation = await this.findOne(id, organizationId);
    const target = conversation.assignedToId
      ? ConversationStatus.OPEN
      : ConversationStatus.PENDING;
    await this.fsm.transition(id, target, actorId);
    return this.repository.findById(id);
  }

  async assignToMe(id: string, organizationId: string, userId: string) {
    await this.findOne(id, organizationId);
    await this.fsm.assign(id, userId, userId);
    return this.repository.findById(id);
  }

  async getStatusCounts(organizationId: string) {
    return this.repository.countByStatus(organizationId);
  }
}
