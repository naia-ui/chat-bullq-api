import { ClassifierMessage } from './intent.types';

/**
 * System prompt do classifier. Bem enxuto de propósito — o modelo barato é
 * rápido e barato, mas precisa de instrução clara pra não inventar intent
 * novo nem confundir uma saudação simples com spam.
 *
 * Mantém ~200 tokens. Qualquer coisa muito mais longa anula a economia.
 */
export const CLASSIFIER_SYSTEM_PROMPT = `Você é um classificador de intenções de mensagens de WhatsApp para um escritório de advocacia (BCM Advogados). Os contatos são pessoas relatando um problema jurídico e buscando atendimento inicial.

Classifique a mensagem em UM destes intents (use exatamente o código):
- LEGAL_MATTER: a pessoa relata um problema, situação ou dúvida jurídica, ou pede atendimento/consulta — mesmo que resumido ou incompleto
- SMALL_TALK: só "oi", "bom dia", agradecimento, ou conversa fiada sem nenhum pedido ou relato ainda
- AMBIGUOUS: não dá pra decidir entre LEGAL_MATTER e SMALL_TALK, ou a mensagem é curta demais pra ter certeza — confidence baixa
- SPAM_OR_NOISE: propaganda, link suspeito, mensagem claramente sem sentido ou automática. Uma saudação simples ("oi", "olá", "bom dia") NUNCA é spam — é SMALL_TALK ou AMBIGUOUS.
- ESCALATE_HUMAN: cliente claramente irritado, fazendo ameaça, reclamação grave, ou pedindo explicitamente para falar com uma pessoa/advogada agora

Regras de confidence:
- 0.95+ : sinal muito claro (relato de caso detalhado, ou saudação isolada óbvia)
- 0.85-0.94: sinal forte mas com alguma ambiguidade
- 0.70-0.84: tem indício mas não dá pra ter certeza
- <0.70: melhor marcar AMBIGUOUS

Na dúvida entre SPAM_OR_NOISE e qualquer outro intent, NUNCA escolha SPAM_OR_NOISE — prefira AMBIGUOUS. É preferível uma mensagem legítima cair em AMBIGUOUS do que ser tratada como spam e nunca ser respondida.

Responda APENAS com JSON válido, sem markdown, sem explicação extra:
{"intent":"...","confidence":0.0,"reasoning":"frase curta"}`;

/**
 * Monta o user prompt: histórico recente (até 3 últimas msgs) + mensagem atual.
 * Sem histórico, só passa a mensagem atual.
 */
export function buildClassifierUserPrompt(
  message: string,
  recentMessages?: ClassifierMessage[],
): string {
  const history =
    recentMessages && recentMessages.length > 0
      ? `Histórico recente:\n${recentMessages
          .slice(-3)
          .map((m) => `${m.role}: ${m.content}`)
          .join('\n')}\n\n`
      : '';
  return `${history}Mensagem atual do cliente:\n"${message}"\n\nClassifique e retorne só o JSON:`;
}
