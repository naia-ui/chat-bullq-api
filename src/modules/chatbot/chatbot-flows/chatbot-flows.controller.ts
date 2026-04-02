import {
  Controller, Get, Post, Patch, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { ChatbotFlowsService } from './chatbot-flows.service';
import {
  CreateChatbotFlowDto, UpdateChatbotFlowDto, SaveNodesDto, LinkChannelsDto,
} from './dto/create-chatbot-flow.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { CurrentOrg, Roles } from '../../../common/decorators';

@ApiTags('Chatbot Flows')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('chatbot-flows')
export class ChatbotFlowsController {
  constructor(private readonly service: ChatbotFlowsService) {}

  @Post()
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Create a chatbot flow' })
  create(@CurrentOrg('id') orgId: string, @Body() dto: CreateChatbotFlowDto) {
    return this.service.create(orgId, dto);
  }

  @Get()
  @ApiOperation({ summary: 'List chatbot flows' })
  findAll(@CurrentOrg('id') orgId: string) {
    return this.service.findAll(orgId);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get chatbot flow with nodes' })
  findOne(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.findOne(id, orgId);
  }

  @Patch(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Update chatbot flow' })
  update(@Param('id') id: string, @CurrentOrg('id') orgId: string, @Body() dto: UpdateChatbotFlowDto) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Delete chatbot flow' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }

  @Post(':id/nodes')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Save all nodes of a flow (replace)' })
  saveNodes(@Param('id') id: string, @CurrentOrg('id') orgId: string, @Body() dto: SaveNodesDto) {
    return this.service.saveNodes(id, orgId, dto.nodes);
  }

  @Post(':id/channels')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Link flow to channels' })
  linkChannels(@Param('id') id: string, @CurrentOrg('id') orgId: string, @Body() dto: LinkChannelsDto) {
    return this.service.linkChannels(id, orgId, dto.channelIds);
  }
}
