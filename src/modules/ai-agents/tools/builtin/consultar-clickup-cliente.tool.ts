import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { HoppeClientService } from '../client-ops/hoppe-client.service';
import { ClickUpClientService } from '../client-ops/clickup-client.service';

/**
 * Consulta READ-ONLY ao ClickUp do CLIENTE em implementação. O token do
 * cliente vem dos custom fields do Hoppe (resolvido server-side) — nunca
 * passa pelo contexto do LLM.
 */
@Injectable()
export class ConsultarClickUpClienteTool implements AiTool {
  private readonly logger = new Logger(ConsultarClickUpClienteTool.name);

  readonly name = 'consultarClickUpCliente';
  readonly description =
    'Consulta o ClickUp REAL do cliente em implementação (somente leitura). Use quando o cliente perguntar sobre o workspace dele: "que lists eu tenho", "como está a task X", "o que tem no space de vendas". Ações: estrutura (Spaces>Folders>Lists), listarTasks (tasks de uma list), verTask (detalhe de uma task). Comece por estrutura pra descobrir os ids.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['clientName', 'acao'],
    properties: {
      clientName: {
        type: 'string',
        description:
          'Nome do cliente/projeto como aparece no grupo ou na conversa (ex: "Mauricio Fachini"). Match parcial e sem acento funciona.',
        minLength: 3,
        maxLength: 120,
      },
      acao: {
        type: 'string',
        enum: ['estrutura', 'listarTasks', 'verTask'],
        description:
          'estrutura = árvore Spaces/Folders/Lists; listarTasks = tasks de uma list (exige listId); verTask = detalhe de task (exige taskId).',
      },
      listId: {
        type: 'string',
        description: 'Obrigatório quando acao=listarTasks.',
      },
      taskId: {
        type: 'string',
        description: 'Obrigatório quando acao=verTask.',
      },
      incluirConcluidas: {
        type: 'boolean',
        description: 'Em listarTasks, inclui tasks fechadas. Default false.',
      },
    },
  };

  constructor(
    private readonly hoppe: HoppeClientService,
    private readonly clickup: ClickUpClientService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!this.hoppe.isConfigured()) {
      return {
        output: { ok: false, error: 'Hoppe não configurado no servidor' },
      };
    }
    const clientName = String(input.clientName ?? '').trim();
    const acao = String(input.acao ?? '');

    const lookup = await this.hoppe.findClientProject(clientName);
    if (!lookup.project) {
      return {
        output: {
          ok: false,
          error:
            lookup.candidates.length > 0
              ? 'Mais de um projeto bate com esse nome — confirme com o cliente qual é.'
              : `Nenhum projeto de implementação encontrado pra "${clientName}".`,
          candidatos: lookup.candidates,
        },
      };
    }
    const { project } = lookup;
    if (!project.clickupApiToken || !project.clickupWorkspaceId) {
      return {
        output: {
          ok: false,
          error: `O projeto "${project.name}" não tem credenciais de ClickUp cadastradas no Hoppe. Avise que vai verificar com a equipe (transferToHuman se o cliente precisar disso agora).`,
        },
      };
    }

    try {
      let data: unknown;
      if (acao === 'estrutura') {
        data = await this.clickup.getWorkspaceTree(
          project.clickupApiToken,
          project.clickupWorkspaceId,
        );
      } else if (acao === 'listarTasks') {
        const listId = String(input.listId ?? '').trim();
        if (!listId) {
          return {
            output: { ok: false, error: 'listId é obrigatório em listarTasks' },
          };
        }
        data = await this.clickup.getListTasks(project.clickupApiToken, listId, {
          includeClosed: input.incluirConcluidas === true,
        });
      } else if (acao === 'verTask') {
        const taskId = String(input.taskId ?? '').trim();
        if (!taskId) {
          return {
            output: { ok: false, error: 'taskId é obrigatório em verTask' },
          };
        }
        data = await this.clickup.getTask(project.clickupApiToken, taskId);
      } else {
        return { output: { ok: false, error: `Ação desconhecida: ${acao}` } };
      }

      this.logger.log(
        `consultarClickUpCliente ${acao} cliente="${project.name}" (run=${ctx.runId})`,
      );
      return { output: { ok: true, cliente: project.name, resultado: data } };
    } catch (err: any) {
      const status = err?.response?.status;
      return {
        output: {
          ok: false,
          error:
            status === 401
              ? 'Token de ClickUp do cliente inválido/expirado — precisa ser atualizado no Hoppe.'
              : `Falha ao consultar ClickUp: ${err?.response?.data?.err ?? err?.message}`,
        },
      };
    }
  }
}
