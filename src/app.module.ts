import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { BullModule } from '@nestjs/bullmq';
import { PrismaModule } from './database/prisma.module';
import { AuthModule } from './modules/auth/auth.module';
import { UsersModule } from './modules/users/users.module';
import { OrganizationsModule } from './modules/organizations/organizations.module';
import { ChannelHubModule } from './modules/channel-hub/channel-hub.module';
import { MessagingModule } from './modules/messaging/messaging.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { NotificationsModule } from './modules/notifications/notifications.module';
import { RoutingModule } from './modules/routing/routing.module';
import { QuickRepliesModule } from './modules/quick-replies/quick-replies.module';
import { TagsModule } from './modules/tags/tags.module';
import { ChatbotModule } from './modules/chatbot/chatbot.module';
import { DashboardModule } from './modules/dashboard/dashboard.module';
import redisConfig from './config/redis.config';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [redisConfig] }),
    BullModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: {
          host: config.get<string>('redis.host', 'localhost'),
          port: config.get<number>('redis.port', 6379),
        },
      }),
    }),
    PrismaModule,
    AuthModule,
    UsersModule,
    OrganizationsModule,
    RealtimeModule,
    ChannelHubModule,
    MessagingModule,
    NotificationsModule,
    RoutingModule,
    QuickRepliesModule,
    TagsModule,
    ChatbotModule,
    DashboardModule,
  ],
})
export class AppModule {}
