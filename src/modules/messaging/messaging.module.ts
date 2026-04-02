import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ChannelHubModule } from '../channel-hub/channel-hub.module';
import { IdempotencyService } from './pipeline/idempotency.service';
import { ContactResolverService } from './pipeline/contact-resolver.service';
import { ConversationResolverService } from './pipeline/conversation-resolver.service';
import { InboundMessageProcessor } from './pipeline/inbound-message.processor';
import { OutboundMessageProcessor } from './pipeline/outbound-message.processor';
import { ConversationFsmService } from './conversations/conversation-fsm.service';
import { ConversationsController } from './conversations/conversations.controller';
import { ConversationsService } from './conversations/conversations.service';
import { ConversationsRepository } from './conversations/conversations.repository';
import { MessagesController } from './messages/messages.controller';
import { MessagesService } from './messages/messages.service';
import { MessagesRepository } from './messages/messages.repository';
import { ContactsController } from './contacts/contacts.controller';
import { ContactsService } from './contacts/contacts.service';
import { ContactsRepository } from './contacts/contacts.repository';

@Module({
  imports: [
    BullModule.registerQueue(
      { name: 'inbound-messages' },
      { name: 'outbound-messages' },
      { name: 'chatbot-processor' },
    ),
    ChannelHubModule,
  ],
  controllers: [ConversationsController, MessagesController, ContactsController],
  providers: [
    IdempotencyService,
    ContactResolverService,
    ConversationResolverService,
    InboundMessageProcessor,
    OutboundMessageProcessor,
    ConversationFsmService,
    ConversationsService,
    ConversationsRepository,
    MessagesService,
    MessagesRepository,
    ContactsService,
    ContactsRepository,
  ],
  exports: [ConversationsService, MessagesService, ConversationFsmService, ContactsService],
})
export class MessagingModule {}
