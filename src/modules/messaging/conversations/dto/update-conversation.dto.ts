import { IsOptional, IsString, IsEnum, MaxLength, ValidateIf } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { ConversationStatus } from '@prisma/client';

export class UpdateConversationDto {
  @ApiPropertyOptional({ enum: ConversationStatus })
  @IsOptional()
  @IsEnum(ConversationStatus)
  status?: ConversationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  assignedToId?: string;

  /** ID da área para transferir; null devolve à caixa de entrada geral. */
  @ApiPropertyOptional({ nullable: true })
  @ValidateIf((o) => o.departmentId !== undefined && o.departmentId !== null)
  @IsString()
  departmentId?: string | null;

  /** Apelido interno da conversa — só nós vemos, o cliente não. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(120)
  subject?: string;
}
