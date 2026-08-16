import { BusinessHoursConfig } from '../router/business-hours.util';

/**
 * Horário de atendimento HUMANO — conceito separado de `org.aiBusinessHours`
 * (que fica `null` de propósito: a Justine responde 24/7, decisão registrada
 * em AUDITORIA_JUSTINE_OS.md). Esse aqui só serve pra decidir se, no momento
 * de um handoff pra humano, avisamos o cliente que agendamento/resposta de
 * advogada especificamente só vem dentro desse horário — a IA continua
 * respondendo tudo que souber fora dele, sem nenhuma restrição.
 *
 * TODO(naia): ajustar se o horário real de atendimento humano do escritório
 * for diferente. Assumido: segunda a sexta, 9h às 18h, fuso
 * America/Sao_Paulo (mesmo default de `organization.aiTimezone`).
 */
export const HUMAN_SUPPORT_HOURS: BusinessHoursConfig = {
  sunday: { enabled: false },
  monday: { enabled: true, windows: [['09:00', '18:00']] },
  tuesday: { enabled: true, windows: [['09:00', '18:00']] },
  wednesday: { enabled: true, windows: [['09:00', '18:00']] },
  thursday: { enabled: true, windows: [['09:00', '18:00']] },
  friday: { enabled: true, windows: [['09:00', '18:00']] },
  saturday: { enabled: false },
};

export const HUMAN_SUPPORT_HOURS_LABEL = 'segunda a sexta, das 9h às 18h';

export const DEFAULT_HANDOFF_OUT_OF_HOURS_MESSAGE =
  `Recebi sua solicitação! Um dos nossos advogados vai te retornar sobre ` +
  `agendamento ou atendimento pessoal dentro do nosso horário de ` +
  `atendimento (${HUMAN_SUPPORT_HOURS_LABEL}). Enquanto isso, posso ` +
  `continuar te ajudando com qualquer outra dúvida que eu souber responder.`;
