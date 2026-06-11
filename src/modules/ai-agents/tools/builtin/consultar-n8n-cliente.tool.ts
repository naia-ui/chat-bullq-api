import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { HoppeClientService } from '../client-ops/hoppe-client.service';
import { N8nClientService } from '../client-ops/n8n-client.service';

/**
 * Consulta READ-ONLY à instância n8n do CLIENTE (automações dele). URL e
 * API key vêm do Hoppe, resolvidas server-side.
 */
@Injectable()
export class ConsultarN8nClienteTool implements AiTool {
  private readonly logger = new Logger(ConsultarN8nClienteTool.name);

  readonly name = 'consultarN8nCliente';
  readonly description =
    'Consulta o n8n do cliente em implementação (somente leitura). Use quando o cliente perguntar das automações: "minha automação rodou?", "o fluxo está ativo?", "deu erro ontem?". Ações: listarWorkflows (nomes + ativo/inativo) e execucoes (últimas execuções, filtráveis por workflowId e status=error).';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['clientName', 'acao'],
    properties: {
      clientName: {
        type: 'string',
        description: 'Nome do cliente/projeto. Match parcial e sem acento.',
        minLength: 3,
        maxLength: 120,
      },
      acao: {
        type: 'string',
        enum: ['listarWorkflows', 'execucoes'],
      },
      workflowId: {
        type: 'string',
        description: 'Em execucoes: filtra por um workflow específico.',
      },
      somenteErros: {
        type: 'boolean',
        description: 'Em execucoes: só execuções com erro. Default false.',
      },
    },
  };

  constructor(
    private readonly hoppe: HoppeClientService,
    private readonly n8n: N8nClientService,
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
              ? 'Mais de um projeto bate com esse nome — confirme qual é.'
              : `Nenhum projeto encontrado pra "${clientName}".`,
          candidatos: lookup.candidates,
        },
      };
    }
    const { project } = lookup;
    if (!project.n8nUrl || !project.n8nApiKey) {
      return {
        output: {
          ok: false,
          error: `O projeto "${project.name}" não tem n8n cadastrado no Hoppe (URL/API key). Pode ser que o cliente use Make ou ainda não tenha automações provisionadas.`,
        },
      };
    }

    try {
      const data =
        acao === 'listarWorkflows'
          ? await this.n8n.listWorkflows(project.n8nUrl, project.n8nApiKey)
          : await this.n8n.listExecutions(project.n8nUrl, project.n8nApiKey, {
              workflowId: input.workflowId
                ? String(input.workflowId)
                : undefined,
              status: input.somenteErros === true ? 'error' : undefined,
            });

      this.logger.log(
        `consultarN8nCliente ${acao} cliente="${project.name}" (run=${ctx.runId})`,
      );
      return { output: { ok: true, cliente: project.name, resultado: data } };
    } catch (err: any) {
      const status = err?.response?.status;
      return {
        output: {
          ok: false,
          error:
            status === 401
              ? 'API key do n8n do cliente inválida — precisa ser atualizada no Hoppe.'
              : `Falha ao consultar n8n do cliente: ${err?.message}`,
        },
      };
    }
  }
}
