import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { UpsertSkillDto } from './dto/upsert-skill.dto';

@Injectable()
export class SkillsCatalogService {
  constructor(private readonly prisma: PrismaService) {}

  async list(organizationId: string) {
    return this.prisma.aiSkill.findMany({
      where: { organizationId, deletedAt: null },
      orderBy: [{ category: 'asc' }, { name: 'asc' }],
      include: {
        tool: { select: { id: true, name: true, source: true } },
        agents: {
          select: { agent: { select: { id: true, name: true } } },
        },
        _count: { select: { agents: true, versions: true } },
      },
    });
  }

  async findOne(organizationId: string, id: string) {
    const skill = await this.prisma.aiSkill.findFirst({
      where: { id, organizationId, deletedAt: null },
      include: {
        tool: true,
        agents: { include: { agent: { select: { id: true, name: true } } } },
      },
    });
    if (!skill) throw new NotFoundException('Skill not found');
    return skill;
  }

  async listVersions(organizationId: string, id: string) {
    await this.findOne(organizationId, id);
    return this.prisma.aiSkillVersion.findMany({
      where: { skillId: id },
      orderBy: { version: 'desc' },
    });
  }

  async create(
    organizationId: string,
    dto: UpsertSkillDto,
    actorId: string | null,
  ) {
    this.assertSourceFields(dto);
    await this.assertToolExists(organizationId, dto.toolId, dto.source);
    await this.assertNameAvailable(organizationId, dto.name);

    return this.prisma.$transaction(async (tx) => {
      const skill = await tx.aiSkill.create({
        data: {
          organizationId,
          name: dto.name,
          description: dto.description,
          category: dto.category,
          promptInstructions: dto.promptInstructions,
          source: dto.source,
          parameters: dto.parameters as object,
          toolId: dto.toolId,
          httpMethod: dto.httpMethod?.toUpperCase(),
          httpPath: dto.httpPath,
          httpHeadersExtra: (dto.httpHeadersExtra as object) ?? null,
          httpBodyTemplate: dto.httpBodyTemplate,
          responseMap: (dto.responseMap as object) ?? null,
          sqlQuery: dto.sqlQuery,
          sqlParamMap: (dto.sqlParamMap as object) ?? null,
          sqlReadOnly: dto.sqlReadOnly ?? true,
          sqlMaxRows: dto.sqlMaxRows ?? 50,
          timeoutMs: dto.timeoutMs ?? 15000,
          isActive: dto.isActive ?? true,
          currentVersion: 1,
        },
      });

      await tx.aiSkillVersion.create({
        data: this.buildVersionSnapshot(skill, 1, actorId, dto.changeNote ?? 'Skill criada'),
      });

      return skill;
    });
  }

  async update(
    organizationId: string,
    id: string,
    dto: UpsertSkillDto,
    actorId: string | null,
  ) {
    const existing = await this.findOne(organizationId, id);
    this.assertSourceFields(dto);
    await this.assertToolExists(organizationId, dto.toolId, dto.source);
    if (existing.name !== dto.name) {
      await this.assertNameAvailable(organizationId, dto.name);
    }

    const nextVersion = existing.currentVersion + 1;

    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.aiSkill.update({
        where: { id },
        data: {
          name: dto.name,
          description: dto.description,
          category: dto.category,
          promptInstructions: dto.promptInstructions,
          source: dto.source,
          parameters: dto.parameters as object,
          toolId: dto.toolId,
          httpMethod: dto.httpMethod?.toUpperCase(),
          httpPath: dto.httpPath,
          httpHeadersExtra: (dto.httpHeadersExtra as object) ?? null,
          httpBodyTemplate: dto.httpBodyTemplate,
          responseMap: (dto.responseMap as object) ?? null,
          sqlQuery: dto.sqlQuery,
          sqlParamMap: (dto.sqlParamMap as object) ?? null,
          sqlReadOnly: dto.sqlReadOnly ?? true,
          sqlMaxRows: dto.sqlMaxRows ?? 50,
          timeoutMs: dto.timeoutMs ?? 15000,
          isActive: dto.isActive ?? true,
          currentVersion: nextVersion,
        },
      });

      await tx.aiSkillVersion.create({
        data: this.buildVersionSnapshot(
          updated,
          nextVersion,
          actorId,
          dto.changeNote ?? 'Skill atualizada',
        ),
      });

      return updated;
    });
  }

  async softDelete(organizationId: string, id: string) {
    await this.findOne(organizationId, id);
    await this.prisma.aiSkill.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ─── Agent ↔ skills ─────────────────────────────────────────────

  async setAgentSkills(
    organizationId: string,
    agentId: string,
    skillIds: string[],
  ) {
    await this.assertAgent(organizationId, agentId);
    if (skillIds.length > 0) {
      const valid = await this.prisma.aiSkill.count({
        where: { id: { in: skillIds }, organizationId, deletedAt: null },
      });
      if (valid !== skillIds.length) {
        throw new BadRequestException('Algum skillId não pertence à org.');
      }
    }
    await this.prisma.$transaction([
      this.prisma.aiAgentSkill.deleteMany({ where: { agentId } }),
      ...(skillIds.length > 0
        ? [
            this.prisma.aiAgentSkill.createMany({
              data: skillIds.map((skillId) => ({ agentId, skillId })),
            }),
          ]
        : []),
    ]);
  }

  // ─── helpers ────────────────────────────────────────────────────

  private assertSourceFields(dto: UpsertSkillDto) {
    if (dto.source === 'HTTP') {
      if (!dto.httpMethod || !dto.httpPath) {
        throw new BadRequestException(
          'HTTP skill requires httpMethod and httpPath',
        );
      }
    } else if (dto.source === 'SQL') {
      if (!dto.sqlQuery) {
        throw new BadRequestException('SQL skill requires sqlQuery');
      }
    }
  }

  private async assertToolExists(
    organizationId: string,
    toolId: string,
    source: 'HTTP' | 'SQL',
  ) {
    const tool = await this.prisma.aiTool.findFirst({
      where: { id: toolId, organizationId, deletedAt: null, isActive: true },
    });
    if (!tool) {
      throw new BadRequestException(
        'Tool não encontrada ou não pertence à organização',
      );
    }
    const expected = source === 'HTTP' ? 'CUSTOM_HTTP' : 'CUSTOM_SQL';
    if (tool.source !== expected) {
      throw new BadRequestException(
        `Tool "${tool.name}" é ${tool.source}, mas a skill é ${source}`,
      );
    }
  }

  private async assertNameAvailable(organizationId: string, name: string) {
    const clash = await this.prisma.aiSkill.findFirst({
      where: { organizationId, name, deletedAt: null },
    });
    if (clash) {
      throw new BadRequestException(`Skill "${name}" já existe.`);
    }
  }

  private async assertAgent(organizationId: string, agentId: string) {
    const agent = await this.prisma.aiAgent.findFirst({
      where: { id: agentId, organizationId, deletedAt: null },
    });
    if (!agent) throw new NotFoundException('Agent not found');
  }

  /** Builds a full snapshot of the skill for the version table. */
  private buildVersionSnapshot(
    skill: any,
    version: number,
    actorId: string | null,
    note: string,
  ) {
    return {
      skillId: skill.id,
      version,
      name: skill.name,
      description: skill.description,
      category: skill.category,
      promptInstructions: skill.promptInstructions,
      source: skill.source,
      parameters: skill.parameters,
      toolId: skill.toolId,
      httpMethod: skill.httpMethod,
      httpPath: skill.httpPath,
      httpHeadersExtra: skill.httpHeadersExtra,
      httpBodyTemplate: skill.httpBodyTemplate,
      responseMap: skill.responseMap,
      sqlQuery: skill.sqlQuery,
      sqlParamMap: skill.sqlParamMap,
      sqlReadOnly: skill.sqlReadOnly,
      sqlMaxRows: skill.sqlMaxRows,
      timeoutMs: skill.timeoutMs,
      changedById: actorId,
      changeNote: note,
    };
  }
}
