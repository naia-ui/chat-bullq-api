import { Injectable, Logger } from '@nestjs/common';
import { Channel } from '@prisma/client';
import axios, { AxiosInstance } from 'axios';

interface InstagramConfig {
  pageAccessToken: string;
  pageId: string;
  igUserId?: string;
  apiVersion?: string;
}

@Injectable()
export class InstagramHttpClient {
  private readonly logger = new Logger(InstagramHttpClient.name);

  private getConfig(channel: Channel): InstagramConfig {
    const config = channel.config as Record<string, any>;
    return {
      pageAccessToken: config.pageAccessToken,
      pageId: config.pageId,
      igUserId: config.igUserId,
      apiVersion: config.apiVersion || 'v21.0',
    };
  }

  private createClient(channel: Channel): AxiosInstance {
    const cfg = this.getConfig(channel);
    return axios.create({
      baseURL: `https://graph.facebook.com/${cfg.apiVersion}`,
      params: { access_token: cfg.pageAccessToken },
      timeout: 30000,
    });
  }

  async sendMessage(
    channel: Channel,
    payload: Record<string, any>,
  ): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.post(
        `/${cfg.pageId}/messages`,
        payload,
      );
      return data;
    } catch (error: any) {
      this.logger.error(
        `Instagram API error: ${error.response?.data?.error?.message || error.message}`,
      );
      throw error;
    }
  }

  async getPageInfo(channel: Channel): Promise<any> {
    const cfg = this.getConfig(channel);
    const client = this.createClient(channel);
    try {
      const { data } = await client.get(`/${cfg.pageId}`, {
        params: { fields: 'id,name,instagram_business_account' },
      });
      return data;
    } catch (error: any) {
      this.logger.error(`Instagram verify failed: ${error.message}`);
      throw error;
    }
  }

  async downloadMedia(url: string): Promise<Buffer> {
    const response = await axios.get(url, {
      responseType: 'arraybuffer',
      timeout: 60000,
    });
    return Buffer.from(response.data);
  }
}
