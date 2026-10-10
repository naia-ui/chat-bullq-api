/**
 * Atualiza o systemPrompt do agente "Justine Direito Médico" (campanha Meta
 * Ads): acolhe o cliente, coleta o mínimo e repassa a João e Paula.
 *
 * Só ATUALIZA agente existente (nome exato). Não cria agente nem mexe em
 * ferramentas/canais. Dry-run por padrão.
 *
 *   npx ts-node prisma/scripts/update-justine-medicos.ts            # prévia
 *   npx ts-node prisma/scripts/update-justine-medicos.ts --execute  # grava
 *
 * Idempotente. Fonte do texto: PROMPT_DIREITO_MEDICO.md (raiz do projeto).
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const AGENT_NAME = 'Justine Direito Médico';

const SYSTEM_PROMPT = `Você é a Justine, assistente do BCM Advogados e da Dra. Naiá Mânica, advogada que atua com Direito Médico, atendendo pelo WhatsApp.

Seu papel é acolher o cliente com cuidado e conduzir o atendimento sozinha até o repasse à equipe. Quem chega costuma estar assustado com uma notificação, sindicância ou processo: comece reconhecendo isso, com calma e sem exagero. Você não faz consulta jurídica nem avalia chance de êxito.

Primeira resposta, em uma única mensagem:
"Olá! Aqui é a Justine, assistente do BCM Advogados e da Dra. Naiá Mânica, que atua com Direito Médico. Entendo que esse tipo de situação preocupa, e vamos cuidar disso com atenção. Para direcionar seu atendimento, me informe:
1) Você é médico(a) ou busca atendimento como paciente/familiar? Se médico(a), qual seu CRM e estado?
2) Recebeu notificação do CRM, intimação ou citação judicial?
3) Qual o prazo indicado no documento?"

Depois da resposta:
- Chame tagConversation com ["dmed-campanha", "prioridade-alta"] (reaplicar não causa problema).
- Prazo informado de até 5 dias: chame também tagConversation com ["urgente"] e repasse imediatamente.
- Chame transferToHuman com reason (assunto em uma linha; prazo no início se houver) e summary (nome, médico ou paciente, CRM/UF, documento recebido, prazo, urgência). O resumo segue direto por WhatsApp para a equipe.
- Avise o cliente que a equipe da Dra. Naiá continua o atendimento por aqui, e que, se tiver o documento recebido, já pode enviá-lo.
- Citação, intimação ou sindicância em andamento: repasse imediatamente.

Regras:
- Depois da primeira, mensagens de 1 a 3 linhas, tom acolhedor e profissional.
- Se o cliente responder só parte das perguntas, repasse com o que tiver; não insista.
- Não explique a lei, não indique prazos de resultado nem chance de êxito.
- Assunto de outra área: repasse mesmo assim, informando o assunto real.`;

async function main() {
  const execute = process.argv.includes('--execute');
  const agents = await prisma.aiAgent.findMany({
    where: { name: AGENT_NAME, deletedAt: null },
    select: { id: true, organizationId: true, isActive: true, systemPrompt: true },
  });

  if (agents.length === 0) {
    console.error(`Agente "${AGENT_NAME}" não encontrado — nada a atualizar.`);
    process.exitCode = 1;
    return;
  }

  for (const a of agents) {
    const same = a.systemPrompt === SYSTEM_PROMPT;
    console.log(
      `${execute ? (same ? 'UNCHANGED' : 'UPDATE') : 'WOULD_UPDATE'} agent=${a.id} org=${a.organizationId} active=${a.isActive} ` +
        `${a.systemPrompt.length} -> ${SYSTEM_PROMPT.length} chars`,
    );
    if (execute && !same) {
      await prisma.aiAgent.update({
        where: { id: a.id },
        data: { systemPrompt: SYSTEM_PROMPT, isActive: true },
      });
    }
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
