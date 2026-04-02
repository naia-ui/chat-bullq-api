import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../common/guards';
import { CurrentOrg } from '../../common/decorators';

@ApiTags('Dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('dashboard')
export class DashboardController {
  constructor(private readonly service: DashboardService) {}

  private parseRange(from?: string, to?: string) {
    const now = new Date();
    return {
      from: from ? new Date(from) : new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
      to: to ? new Date(to) : now,
    };
  }

  @Get('overview')
  @ApiOperation({ summary: 'Get dashboard overview metrics' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getOverview(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getOverview(orgId, this.parseRange(from, to));
  }

  @Get('volume-by-day')
  @ApiOperation({ summary: 'Conversations volume by day' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeByDay(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getVolumeByDay(orgId, this.parseRange(from, to));
  }

  @Get('volume-by-channel')
  @ApiOperation({ summary: 'Conversations volume by channel' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getVolumeByChannel(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getVolumeByChannel(orgId, this.parseRange(from, to));
  }

  @Get('volume-by-status')
  @ApiOperation({ summary: 'Conversations by status (current)' })
  getVolumeByStatus(@CurrentOrg('id') orgId: string) {
    return this.service.getVolumeByStatus(orgId);
  }

  @Get('agent-performance')
  @ApiOperation({ summary: 'Agent performance metrics' })
  @ApiQuery({ name: 'from', required: false }) @ApiQuery({ name: 'to', required: false })
  getAgentPerformance(@CurrentOrg('id') orgId: string, @Query('from') from?: string, @Query('to') to?: string) {
    return this.service.getAgentPerformance(orgId, this.parseRange(from, to));
  }
}
