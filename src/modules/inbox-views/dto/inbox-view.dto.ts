import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Length,
  Min,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';

/**
 * Filters stored as JSON in `inbox_views.filters`. All optional. The view
 * matches conversations that satisfy ALL provided filters (AND).
 */
export class InboxViewFiltersDto {
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  channelIds?: string[];

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  statuses?: string[]; // PENDING / OPEN / WAITING / CLOSED / BOT

  /** "me" = current user, "none" = unassigned, "any" = no filter, or a userId */
  @IsOptional()
  @IsString()
  assignedTo?: string;

  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tagIds?: string[];

  @IsOptional()
  @IsString()
  @IsIn(['inbound', 'outbound', 'any'])
  lastDirection?: string;

  /** INDIVIDUAL = 1-on-1, GROUP = group chats. Undefined = both. */
  @IsOptional()
  @IsString()
  @IsIn(['INDIVIDUAL', 'GROUP'])
  kind?: 'INDIVIDUAL' | 'GROUP';

  /**
   * Static inbox: when set, the view shows ONLY these conversations.
   * Used by bulk-action "create inbox from selection" — operator picks N
   * conversations and pins them in a fixed list. Other filters are still
   * intersected (so a closed conversation in the list won't show up if
   * statuses=[OPEN]).
   */
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  conversationIds?: string[];
}

export class CreateInboxViewDto {
  @IsString()
  @Length(1, 60)
  name!: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @ValidateNested()
  @Type(() => InboxViewFiltersDto)
  filters!: InboxViewFiltersDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class UpdateInboxViewDto {
  @IsOptional()
  @IsString()
  @Length(1, 60)
  name?: string;

  @IsOptional()
  @IsString()
  icon?: string;

  @IsOptional()
  @IsString()
  color?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => InboxViewFiltersDto)
  filters?: InboxViewFiltersDto;

  @IsOptional()
  @IsInt()
  @Min(0)
  order?: number;
}

export class ReorderInboxViewsDto {
  @IsArray()
  @IsString({ each: true })
  ids!: string[]; // ordered list
}
