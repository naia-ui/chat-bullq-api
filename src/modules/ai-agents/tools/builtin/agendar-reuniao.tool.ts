import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { HoppeClientService } from '../client-ops/hoppe-client.service';
import { GoogleAuthService } from '../client-ops/google-auth.service';
import { GoogleCalendarService } from '../client-ops/google-calendar.service';
import { GroupNotifyService } from '../client-ops/group-notify.service';

/**
 * Agendamento completo de reunião de implementação, padrão Bravy:
 *   1. Task no Hoppe (list Agenda clientes, "Tema – Projeto – HOPPEid")
 *   2. Evento no Google Calendar com Meet + convites por email
 *   3. Aviso no grupo WhatsApp do cliente (JID do Hoppe)
 *
 * A tool é AUTÔNOMA (sem gate de aprovação) — por isso a descrição exige
 * confirmação explícita do cliente antes da chamada, e o runner audita
 * tudo em ai_tool_calls.
 */
@Injectable()
export class AgendarReuniaoTool implements AiTool {
  private readonly logger = new Logger(AgendarReuniaoTool.name);

  readonly name = 'agendarReuniao';
  readonly description =
    'Agenda uma reunião REAL: cria task no Hoppe, evento no Google Calendar com Meet (convites por email) e avisa no grupo WhatsApp do cliente. SÓ CHAME depois que o cliente confirmar POR ESCRITO tema, data e horário — repita os dados pra ele confirmar antes. NUNCA chame duas vezes pro mesmo pedido (se falhar parcialmente, leia os warnings e avise o cliente em vez de repetir).';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['clientName', 'tema', 'inicioIso'],
    properties: {
      clientName: {
        type: 'string',
        description: 'Nome do cliente/projeto (match parcial, sem acento).',
        minLength: 3,
        maxLength: 120,
      },
      tema: {
        type: 'string',
        description:
          'Tema curto da reunião (ex: "Alinhamento ClickUp", "Revisão de automações"). Vira o início do título.',
        minLength: 3,
        maxLength: 80,
      },
      inicioIso: {
        type: 'string',
        description:
          'Início CONFIRMADO pelo cliente, ISO 8601 com offset de Brasília (ex: "2026-06-15T14:00:00-03:00"). Sempre no futuro.',
      },
      duracaoMin: {
        type: 'integer',
        minimum: 15,
        maximum: 240,
        description: 'Duração em minutos. Default 60.',
      },
      emailsConvidados: {
        type: 'array',
        items: { type: 'string' },
        maxItems: 10,
        description:
          'Emails dos participantes do lado do cliente (pergunte se ele quer receber convite por email). O time da Bravy já entra automaticamente.',
      },
      avisarGrupo: {
        type: 'boolean',
        description:
          'Mandar resumo no grupo WhatsApp do cliente. Default true. Use false se o cliente pedir discrição.',
      },
    },
  };

  constructor(
    private readonly config: ConfigService,
    private readonly hoppe: HoppeClientService,
    private readonly auth: GoogleAuthService,
    private readonly calendar: GoogleCalendarService,
    private readonly groupNotify: GroupNotifyService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!this.hoppe.isConfigured() || !this.auth.hasOAuth()) {
      return {
        output: {
          ok: false,
          error:
            'Agendamento não configurado no servidor (Hoppe/Google) — use transferToHuman.',
        },
      };
    }

    const clientName = String(input.clientName ?? '').trim();
    const tema = String(input.tema ?? '').trim();
    const inicioIso = String(input.inicioIso ?? '').trim();
    const duracaoMin = Math.min(Number(input.duracaoMin ?? 60) || 60, 240);
    const emails = (Array.isArray(input.emailsConvidados)
      ? input.emailsConvidados
      : []
    )
      .map((e) => String(e).trim().toLowerCase())
      .filter((e) => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e));
    const avisarGrupo = input.avisarGrupo !== false;

    const start = new Date(inicioIso);
    if (Number.isNaN(start.getTime())) {
      return {
        output: {
          ok: false,
          error: 'inicioIso inválido — use ISO 8601 com offset (ex: 2026-06-15T14:00:00-03:00).',
        },
      };
    }
    if (start.getTime() < Date.now() + 5 * 60 * 1000) {
      return {
        output: {
          ok: false,
          error: 'O horário precisa estar no futuro. Confirme a data com o cliente.',
        },
      };
    }
    const end = new Date(start.getTime() + duracaoMin * 60 * 1000);

    const lookup = await this.hoppe.findClientProject(clientName);
    if (!lookup.project) {
      return {
        output: {
          ok: false,
          error:
            lookup.candidates.length > 0
              ? 'Mais de um projeto bate com esse nome — confirme qual é antes de agendar.'
              : `Nenhum projeto encontrado pra "${clientName}".`,
          candidatos: lookup.candidates,
        },
      };
    }
    const { project } = lookup;
    const warnings: string[] = [];

    // 1. Task no Hoppe (se falhar, aborta — é o registro canônico)
    const meeting = await this.hoppe.createMeetingTask({
      project,
      topic: tema,
      startMs: start.getTime(),
      endMs: end.getTime(),
    });

    // 2. Evento no Calendar com Meet
    let eventLink: string | null = null;
    let meetLink: string | null = null;
    try {
      const internalAttendees = (
        this.config.get<string>('SOFIA_MEETING_INTERNAL_ATTENDEES') ??
        'tiago@asv.digital'
      )
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      const event = await this.calendar.createEventWithMeet({
        summary: meeting.taskName,
        description: `Reunião agendada pela Sofia (implementação Bravy). Projeto: ${project.name}.`,
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        attendeeEmails: [...new Set([...internalAttendees, ...emails])],
      });
      eventLink = event.htmlLink;
      meetLink = event.meetLink;
    } catch (err: any) {
      warnings.push(
        `Task criada no Hoppe, mas o evento no Calendar falhou: ${err?.response?.data?.error?.message ?? err?.message}. Um humano precisa criar o convite.`,
      );
    }

    // 3. Aviso no grupo (best effort)
    let grupoAvisado = false;
    if (avisarGrupo && meetLink) {
      if (!project.whatsappGroupJid) {
        warnings.push(
          'Projeto sem "ID do grupo" cadastrado no Hoppe — aviso no grupo não enviado.',
        );
      } else {
        try {
          const dataFmt = new Intl.DateTimeFormat('pt-BR', {
            dateStyle: 'full',
            timeStyle: 'short',
            timeZone: 'America/Sao_Paulo',
          }).format(start);
          const result = await this.groupNotify.notifyGroupByJid({
            organizationId: ctx.organizationId,
            groupJid: project.whatsappGroupJid,
            currentConversationId: ctx.conversationId,
            senderName: 'Sofia',
            text: `Reunião confirmada: ${tema}\n\nQuando: ${dataFmt}\nDuração: ${duracaoMin} min\nLink do Meet: ${meetLink}\n\nQualquer imprevisto é só avisar por aqui que a gente remarca.`,
          });
          grupoAvisado = result.sent;
          if (!result.sent && result.reason !== 'skipped_same_conversation') {
            warnings.push(`Aviso no grupo não enviado: ${result.reason}`);
          }
        } catch (err: any) {
          warnings.push(`Aviso no grupo falhou: ${err?.message}`);
        }
      }
    }

    this.logger.log(
      `agendarReuniao cliente="${project.name}" inicio=${inicioIso} hoppe=${meeting.taskId} event=${eventLink ? 'ok' : 'FALHOU'} (run=${ctx.runId})`,
    );

    return {
      output: {
        ok: true,
        reuniao: meeting.taskName,
        hoppeTaskId: meeting.taskId,
        linkEvento: eventLink,
        linkMeet: meetLink,
        grupoAvisado,
        avisos: warnings,
        instrucao:
          warnings.length > 0
            ? 'Houve falhas parciais — informe o cliente do que deu certo e diga que o restante será ajustado pela equipe. NÃO chame agendarReuniao de novo.'
            : 'Confirme pro cliente com o link do Meet.',
      },
    };
  }
}
