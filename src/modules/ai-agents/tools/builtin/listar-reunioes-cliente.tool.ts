import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { GoogleAuthService } from '../client-ops/google-auth.service';
import { GoogleDriveService } from '../client-ops/google-drive.service';

/**
 * Lista as transcrições de reuniões gravadas de um cliente (Google Drive).
 * Passo 1 do fluxo de reuniões — o passo 2 é lerTranscricaoReuniao.
 */
@Injectable()
export class ListarReunioesClienteTool implements AiTool {
  private readonly logger = new Logger(ListarReunioesClienteTool.name);

  readonly name = 'listarReunioesCliente';
  readonly description =
    'Lista as reuniões gravadas (transcrições no Drive) de um cliente, da mais recente pra mais antiga. Use quando o cliente mencionar reunião passada: "o que ficou definido na última call", "na reunião de ontem falamos de X". Retorna fileId + título + data de cada transcrição — depois use lerTranscricaoReuniao no fileId certo.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['clientName'],
    properties: {
      clientName: {
        type: 'string',
        description:
          'Nome do cliente como aparece no título das gravações (ex: "Mauricio Fachini"). Tente variações se não achar (com/sem sobrenome).',
        minLength: 3,
        maxLength: 120,
      },
      limite: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Quantas reuniões listar. Default 10.',
      },
    },
  };

  constructor(
    private readonly auth: GoogleAuthService,
    private readonly drive: GoogleDriveService,
  ) {}

  async execute(
    input: Record<string, unknown>,
    ctx: ToolContext,
  ): Promise<ToolResult> {
    if (!this.auth.hasServiceAccount()) {
      return {
        output: {
          ok: false,
          error: 'Google Drive não configurado no servidor (GOOGLE_SA_JSON_B64)',
        },
      };
    }
    const clientName = String(input.clientName ?? '').trim();
    const limite = Math.min(Number(input.limite ?? 10) || 10, 20);

    try {
      const { files, warnings } = await this.drive.searchTranscripts(
        clientName,
        limite,
      );
      this.logger.log(
        `listarReunioesCliente "${clientName}" → ${files.length} arquivos (run=${ctx.runId})`,
      );
      if (files.length === 0) {
        return {
          output: {
            ok: true,
            reunioes: [],
            dica: 'Nada encontrado com esse nome. Tente outra grafia (com/sem acento, só primeiro nome) ou pergunte ao cliente quando foi a reunião.',
            avisos: warnings,
          },
        };
      }
      return {
        output: {
          ok: true,
          reunioes: files.map((f) => ({
            fileId: f.fileId,
            titulo: f.title,
            modificadoEm: f.modifiedAt,
            fonte: f.source,
          })),
          avisos: warnings,
        },
      };
    } catch (err: any) {
      return {
        output: {
          ok: false,
          error: `Falha ao buscar reuniões no Drive: ${err?.message}`,
        },
      };
    }
  }
}
