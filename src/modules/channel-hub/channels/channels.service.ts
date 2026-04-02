import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Logger,
} from '@nestjs/common';
import { ChannelType } from '@prisma/client';
import { ChannelsRepository } from './channels.repository';
import { CreateChannelDto } from './dto/create-channel.dto';
import { UpdateChannelDto } from './dto/update-channel.dto';
import { ChannelAdapterRegistry } from '../channel-adapter.registry';
import { ZappfyHttpClient } from '../adapters/zappfy/zappfy.http-client';
import { WhatsAppOfficialHttpClient } from '../adapters/whatsapp-official/whatsapp-official.http-client';
import { InstagramHttpClient } from '../adapters/instagram/instagram.http-client';

@Injectable()
export class ChannelsService {
  private readonly logger = new Logger(ChannelsService.name);

  constructor(
    private readonly repository: ChannelsRepository,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly zappfyHttpClient: ZappfyHttpClient,
    private readonly waOfficialHttpClient: WhatsAppOfficialHttpClient,
    private readonly instagramHttpClient: InstagramHttpClient,
  ) {}

  async create(organizationId: string, dto: CreateChannelDto) {
    return this.repository.create({
      organizationId,
      type: dto.type,
      name: dto.name,
      config: dto.config,
      webhookSecret: dto.webhookSecret,
    });
  }

  async findAll(organizationId: string) {
    return this.repository.findByOrganization(organizationId);
  }

  async findOne(id: string, organizationId: string) {
    const channel = await this.repository.findById(id);
    if (!channel) throw new NotFoundException('Channel not found');
    if (channel.organizationId !== organizationId) {
      throw new ForbiddenException();
    }
    return channel;
  }

  async update(id: string, organizationId: string, dto: UpdateChannelDto) {
    await this.findOne(id, organizationId);
    return this.repository.update(id, dto);
  }

  async remove(id: string, organizationId: string) {
    await this.findOne(id, organizationId);
    return this.repository.softDelete(id);
  }

  async findActiveByType(type: ChannelType) {
    return this.repository.findActiveByType(type);
  }

  async testConnection(id: string, organizationId: string) {
    const channel = await this.findOne(id, organizationId);

    try {
      switch (channel.type) {
        case ChannelType.WHATSAPP_ZAPPFY: {
          const status = await this.zappfyHttpClient.getInstanceStatus(channel);
          return {
            success: true,
            status: status?.state || status?.status || 'connected',
            data: status,
          };
        }

        case ChannelType.WHATSAPP_OFFICIAL: {
          const info = await this.waOfficialHttpClient.verifyPhoneNumber(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              phoneNumber: info.display_phone_number,
              qualityRating: info.quality_rating,
              verifiedName: info.verified_name,
            },
          };
        }

        case ChannelType.INSTAGRAM: {
          const info = await this.instagramHttpClient.getPageInfo(channel);
          return {
            success: true,
            status: 'connected',
            data: {
              pageId: info.id,
              pageName: info.name,
              igAccountId: info.instagram_business_account?.id,
            },
          };
        }

        default:
          return { success: false, error: 'Unsupported channel type' };
      }
    } catch (error: any) {
      return {
        success: false,
        error: error.response?.data?.error?.message || error.message,
      };
    }
  }
}
