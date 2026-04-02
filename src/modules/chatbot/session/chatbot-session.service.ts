import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';
import { ChatbotSession } from './chatbot-session.types';

@Injectable()
export class ChatbotSessionService {
  private readonly logger = new Logger(ChatbotSessionService.name);
  private readonly redis: Redis;
  private readonly TTL = 86400; // 24h

  constructor(private readonly config: ConfigService) {
    this.redis = new Redis({
      host: this.config.get<string>('REDIS_HOST', 'localhost'),
      port: this.config.get<number>('REDIS_PORT', 6379),
    });
  }

  private key(conversationId: string): string {
    return `bot:session:${conversationId}`;
  }

  async get(conversationId: string): Promise<ChatbotSession | null> {
    const raw = await this.redis.get(this.key(conversationId));
    return raw ? JSON.parse(raw) : null;
  }

  async create(conversationId: string, flowId: string, startNodeId: string): Promise<ChatbotSession> {
    const session: ChatbotSession = {
      flowId,
      conversationId,
      currentNodeId: startNodeId,
      variables: {},
      waitingForInput: false,
      startedAt: new Date().toISOString(),
      lastActivityAt: new Date().toISOString(),
    };
    await this.redis.setex(this.key(conversationId), this.TTL, JSON.stringify(session));
    return session;
  }

  async update(conversationId: string, updates: Partial<ChatbotSession>): Promise<ChatbotSession | null> {
    const session = await this.get(conversationId);
    if (!session) return null;
    const updated = { ...session, ...updates, lastActivityAt: new Date().toISOString() };
    await this.redis.setex(this.key(conversationId), this.TTL, JSON.stringify(updated));
    return updated;
  }

  async setVariable(conversationId: string, name: string, value: any): Promise<void> {
    const session = await this.get(conversationId);
    if (!session) return;
    session.variables[name] = value;
    session.lastActivityAt = new Date().toISOString();
    await this.redis.setex(this.key(conversationId), this.TTL, JSON.stringify(session));
  }

  async destroy(conversationId: string): Promise<void> {
    await this.redis.del(this.key(conversationId));
  }

  async exists(conversationId: string): Promise<boolean> {
    return (await this.redis.exists(this.key(conversationId))) === 1;
  }
}
