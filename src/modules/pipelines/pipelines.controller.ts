import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Put,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { PipelinesService } from './pipelines.service';
import {
  CreateCardDto,
  CreatePipelineDto,
  MoveCardDto,
  UpdateCardDto,
  UpdatePipelineDto,
  UpsertStageDto,
} from './dto/pipeline.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';

@ApiTags('Pipelines (Kanban)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('pipelines')
export class PipelinesController {
  constructor(private readonly service: PipelinesService) {}

  @Get()
  @ApiOperation({ summary: 'List pipelines for current org' })
  list(@CurrentOrg('id') orgId: string) {
    return this.service.listPipelines(orgId);
  }

  @Post()
  @ApiOperation({ summary: 'Create a pipeline (with default stages if empty)' })
  create(
    @CurrentOrg('id') orgId: string,
    @Body() dto: CreatePipelineDto,
  ) {
    return this.service.createPipeline(orgId, dto);
  }

  @Get(':id/board')
  @ApiOperation({ summary: 'Get full kanban board (stages + cards by stage)' })
  board(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.getBoard(id, orgId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update pipeline metadata' })
  update(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdatePipelineDto,
  ) {
    return this.service.updatePipeline(id, orgId, dto);
  }

  @Delete(':id')
  @ApiOperation({ summary: 'Delete pipeline (cascade stages + cards)' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.removePipeline(id, orgId);
  }

  @Put(':id/stages')
  @ApiOperation({
    summary: 'Replace stages in bulk (upsert + delete orphans w/o cards)',
  })
  upsertStages(
    @Param('id') id: string,
    @CurrentOrg('id') orgId: string,
    @Body() body: { stages: UpsertStageDto[] },
  ) {
    return this.service.upsertStages(id, orgId, body.stages ?? []);
  }

  // ─── Cards ────────────────────────────────────

  @Get('cards/by-conversation/:conversationId')
  @ApiOperation({
    summary:
      'List all cards (across pipelines) linked to a conversation. Used by the inbox header to show/edit/remove pipeline membership inline.',
  })
  cardsByConversation(
    @Param('conversationId') conversationId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.listCardsByConversation(conversationId, orgId);
  }

  @Post(':id/cards')
  @ApiOperation({ summary: 'Create a card in this pipeline' })
  createCard(
    @Param('id') pipelineId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: CreateCardDto,
  ) {
    return this.service.createCard(pipelineId, orgId, dto);
  }

  @Patch('cards/:cardId')
  @ApiOperation({ summary: 'Update card fields' })
  updateCard(
    @Param('cardId') cardId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: UpdateCardDto,
  ) {
    return this.service.updateCard(cardId, orgId, dto);
  }

  @Delete('cards/:cardId')
  @ApiOperation({ summary: 'Delete a card' })
  removeCard(
    @Param('cardId') cardId: string,
    @CurrentOrg('id') orgId: string,
  ) {
    return this.service.removeCard(cardId, orgId);
  }

  @Post('cards/:cardId/move')
  @ApiOperation({
    summary:
      'Drag-drop a card to a stage at a specific index (0-based). Atomic.',
  })
  moveCard(
    @Param('cardId') cardId: string,
    @CurrentOrg('id') orgId: string,
    @Body() dto: MoveCardDto,
  ) {
    return this.service.moveCard(cardId, orgId, dto);
  }
}
