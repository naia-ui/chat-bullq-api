import {
  Controller,
  Get,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { CurrentOrg, Roles } from '../../common/decorators';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { ConversionsService } from './conversions.service';

/**
 * Fila de conversões: o que saiu para Meta e Google, o que espera a
 * carência, o que foi recusado e por quê.
 *
 * Reprocessar e despachar à mão são ações de sócia ou admin — mover o card
 * continua sendo o único jeito de criar conversão.
 */
@ApiTags('Conversões (Meta Ads / Google Ads)')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('conversions')
export class ConversionsController {
  constructor(private readonly service: ConversionsService) {}

  @Get()
  @ApiOperation({
    summary: 'Relatório da fila de conversões (estado das chaves + últimas 50)',
  })
  report(@CurrentOrg('id') orgId: string, @Query('days') days?: string) {
    const parsed = Number(days);
    return this.service.report(
      orgId,
      Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 180) : 30,
    );
  }

  @Post('dispatch')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({
    summary:
      'Roda o despachante agora (respeita carência, janela e todas as chaves)',
  })
  dispatch() {
    return this.service.dispatchDue();
  }

  @Post(':id/retry')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Devolve à fila uma conversão recusada ou descartada' })
  retry(@CurrentOrg('id') orgId: string, @Param('id') id: string) {
    return this.service.retry(id, orgId);
  }
}
