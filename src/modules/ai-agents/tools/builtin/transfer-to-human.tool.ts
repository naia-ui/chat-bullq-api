import { Injectable, Logger } from '@nestjs/common';
import { HandoffExecutionService } from '../../handoff/handoff-execution.service';
import { AiTool, ToolContext, ToolResult } from '../tool.types';

/**
 * Hands the conversation off to a human. Pauses AI on this conversation
 * (so the agent stops responding), moves the pipeline card, and fires the
 * handoff notifications — all IMMEDIATE, no manual approval step.
 *
 * Até 17/08/2026 isso passava por um `PendingAction` que exigia alguém
 * clicar "aprovar" no painel antes do handoff virar real — quebrava o
 * atendimento 24/7 (a IA já tinha dito ao cliente "um humano vai
 * continuar" mas nada de fato acontecia até alguém abrir o painel).
 * Decisão explícita: "IA qualifica e repassa direto, sem clique" — ver
 * HandoffExecutionService pra lógica real (pausa IA + card + avisos).
 */
@Injectable()
export class TransferToHumanTool implements AiTool {
  private readonly logger = new Logger(TransferToHumanTool.name);

  readonly name = 'transferToHuman';
  readonly description =
    'Hand the conversation over to a human agent. Use this when: the request is outside your competence, the customer explicitly asks for a person, the situation is sensitive (complaint, refund, anger), or you are uncertain. Executes IMMEDIATELY — the AI pauses on this conversation right away, no approval needed.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['reason'],
    properties: {
      reason: {
        type: 'string',
        description:
          'Short reason for the handoff, in PT-BR. Visible to the human as an internal note. e.g., "Cliente pediu reembolso, fora do meu escopo".',
        minLength: 3,
        maxLength: 500,
      },
      summary: {
        type: 'string',
        description:
          'Optional short summary of the conversation so far so the human picks up faster.',
        maxLength: 1000,
      },
    },
  };

  constructor(private readonly handoffExecution: HandoffExecutionService) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    const reason =
      String(input.reason ?? '').trim() || 'Handoff sem motivo informado';

    const result = await this.handoffExecution.execute({
      conversationId: ctx.conversationId,
      agentId: ctx.agentId,
      reason,
    });

    this.logger.log(
      `Agent ${ctx.agentId} transferred conv ${ctx.conversationId} to human (reason="${reason}")`,
    );

    return {
      output: {
        ok: true,
        status: 'transferred',
        transferredAt: result.transferredAt,
        message: 'Transferência concluída — atendente humano já assumiu.',
        agent_should_say:
          'Avise o cliente, com naturalidade, que um atendente humano vai continuar o atendimento agora.',
      },
      // Sinal de "saí do loop" — o agent deve parar de responder, o
      // handoff já é real (aiEnabled=false na conversa).
      finalAction: 'TRANSFERRED_TO_HUMAN',
    };
  }
}
