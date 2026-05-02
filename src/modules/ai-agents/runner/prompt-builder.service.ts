import { Injectable } from '@nestjs/common';
import { Eta } from 'eta';
import {
  AiAgent,
  Channel,
  Contact,
  Conversation,
  Message,
  Organization,
} from '@prisma/client';
import { LlmMessage } from '../llm/llm.types';

export interface PromptContext {
  organization: Organization;
  agent: AiAgent;
  channel: Channel;
  contact: Contact;
  conversation: Conversation;
  recentMessages: Message[];
  memorySummary: string | null;
  memoryFacts: Record<string, unknown> | null;
  triggerMessage: Message;
  /** Extra prompt fragments contributed by the agent's active skills. */
  skillInstructions?: string[];
}

const SYSTEM_TEMPLATE = `Você é <%= it.agent.name %>, atendente virtual da <%= it.organization.name %>.

<%= it.agent.systemPrompt %>

═══ Contexto da conversa ═══
- Canal: <%= it.channel.name %> (<%= it.channel.type %>)
- Cliente: <%= it.contact.name || 'Sem nome cadastrado' %><% if (it.contact.phone) { %>
- Telefone: <%= it.contact.phone %><% } %><% if (it.contact.email) { %>
- E-mail: <%= it.contact.email %><% } %>
- Hora atual: <%= it.now %> (<%= it.organization.aiTimezone %>)
<% if (it.memorySummary) { %>
═══ Memória de interações anteriores ═══
<%= it.memorySummary %>
<% } %>
<% if (it.memoryFacts && Object.keys(it.memoryFacts).length > 0) { %>
═══ Fatos sobre este cliente ═══
<% for (const [key, value] of Object.entries(it.memoryFacts)) { %>
- <%= key %>: <%= JSON.stringify(value) %>
<% } %>
<% } %>

═══ Regras ═══
- Responda sempre em português do Brasil, tom natural e direto.
- NÃO se identifique como IA a menos que perguntado diretamente.
- Sempre que tiver uma resposta pra dar, use a tool \`replyToConversation\`.
- Se a demanda fugir do seu escopo, use \`transferToHuman\` com motivo claro.
- Use \`tagConversation\` pra categorizar o pedido (ex: "billing", "duvida-tecnica", "lead-quente").
- Se o cliente já está satisfeito e a conversa pode fechar, responda e depois pode parar.
- NUNCA invente informações. Se não souber, transfira ou pergunte.
- Mensagens curtas. Uma ideia por mensagem.
<% if (it.skillInstructions && it.skillInstructions.length > 0) { %>

═══ Skills ativas ═══
<% for (const inst of it.skillInstructions) { %>

<%= inst %>
<% } %>
<% } %>`;

@Injectable()
export class PromptBuilderService {
  private readonly eta = new Eta({ autoEscape: false });

  /**
   * Builds the message array sent to the LLM. The system prompt is split
   * into a stable cacheable block (instructions + agent persona) and a
   * volatile block (current time, recent messages) so Anthropic prompt
   * caching kicks in on repeat turns of the same conversation.
   */
  buildMessages(ctx: PromptContext): LlmMessage[] {
    const systemText = this.eta.renderString(SYSTEM_TEMPLATE, {
      ...ctx,
      now: this.formatNow(ctx.organization.aiTimezone),
    });

    const messages: LlmMessage[] = [
      {
        role: 'system',
        content: [
          // The persona + rules block — stable across turns of this conv.
          { type: 'text', text: systemText, cache: true },
        ],
      },
    ];

    // Recent message history → user/assistant turns. We merge consecutive
    // messages from the same author into a single turn for clarity.
    for (const m of ctx.recentMessages) {
      const text = this.extractText(m);
      if (!text) continue;

      const isInbound = m.direction === 'INBOUND';
      messages.push({
        role: isInbound ? 'user' : 'assistant',
        content: text,
      });
    }

    return messages;
  }

  private extractText(message: Message): string {
    const content = message.content as Record<string, unknown>;
    if (typeof content?.text === 'string') return content.text as string;
    if (typeof content?.caption === 'string') return content.caption as string;
    if (message.type !== 'TEXT') return `[${message.type.toLowerCase()}]`;
    return '';
  }

  private formatNow(timezone: string): string {
    try {
      return new Intl.DateTimeFormat('pt-BR', {
        timeZone: timezone,
        dateStyle: 'full',
        timeStyle: 'short',
      }).format(new Date());
    } catch {
      return new Date().toISOString();
    }
  }
}
