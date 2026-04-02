import { IsString, IsOptional, IsBoolean, IsArray, IsObject, IsEnum } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateChatbotFlowDto {
  @ApiProperty({ example: 'Atendimento Inicial' })
  @IsString()
  name: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional({ enum: ['KEYWORD', 'ALWAYS', 'FIRST_MESSAGE'] })
  @IsOptional()
  @IsEnum(['KEYWORD', 'ALWAYS', 'FIRST_MESSAGE'])
  triggerType?: string;

  @ApiPropertyOptional({ example: { keywords: ['oi', 'menu'] } })
  @IsOptional()
  @IsObject()
  triggerConfig?: Record<string, any>;
}

export class UpdateChatbotFlowDto {
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() isActive?: boolean;
  @ApiPropertyOptional() @IsOptional() @IsString() triggerType?: string;
  @ApiPropertyOptional() @IsOptional() @IsObject() triggerConfig?: Record<string, any>;
  @ApiPropertyOptional() @IsOptional() @IsArray() variables?: any[];
}

export class SaveNodesDto {
  @ApiProperty({ type: 'array' })
  @IsArray()
  nodes: ChatbotNodeDto[];
}

export class ChatbotNodeDto {
  @ApiPropertyOptional() @IsOptional() @IsString() id?: string;
  @ApiProperty() @IsString() type: string;
  @ApiPropertyOptional() @IsOptional() @IsString() name?: string;
  @ApiProperty() positionX: number;
  @ApiProperty() positionY: number;
  @ApiProperty() @IsObject() data: Record<string, any>;
  @ApiProperty() @IsArray() edges: { targetNodeId: string; condition?: string }[];
}

export class LinkChannelsDto {
  @ApiProperty({ type: [String] })
  @IsArray()
  @IsString({ each: true })
  channelIds: string[];
}
