import { Controller, Get, Patch, Delete, Param, Body, Query, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiTags, ApiOperation, ApiQuery } from '@nestjs/swagger';
import { OrgRole } from '@prisma/client';
import { ContactsService } from './contacts.service';
import { UpdateContactDto } from './dto/update-contact.dto';
import { JwtAuthGuard, OrgGuard, RolesGuard } from '../../../common/guards';
import { CurrentOrg, Roles } from '../../../common/decorators';

@ApiTags('Contacts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, OrgGuard, RolesGuard)
@Controller('contacts')
export class ContactsController {
  constructor(private readonly service: ContactsService) {}

  @Get()
  @ApiOperation({ summary: 'List contacts with search and pagination' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({ name: 'page', required: false })
  @ApiQuery({ name: 'limit', required: false })
  findAll(
    @CurrentOrg('id') orgId: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    return this.service.findAll(orgId, search, parseInt(page || '1', 10), parseInt(limit || '20', 10));
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get contact detail with channels, tags, conversations' })
  findOne(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.findOne(id, orgId);
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Update contact (name, phone, email, notes, metadata)' })
  update(@Param('id') id: string, @CurrentOrg('id') orgId: string, @Body() dto: UpdateContactDto) {
    return this.service.update(id, orgId, dto);
  }

  @Delete(':id')
  @Roles(OrgRole.OWNER, OrgRole.ADMIN)
  @ApiOperation({ summary: 'Soft delete contact' })
  remove(@Param('id') id: string, @CurrentOrg('id') orgId: string) {
    return this.service.remove(id, orgId);
  }
}
