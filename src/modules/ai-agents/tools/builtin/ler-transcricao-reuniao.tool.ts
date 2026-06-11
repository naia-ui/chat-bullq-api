import { Injectable, Logger } from '@nestjs/common';
import { AiTool, ToolContext, ToolResult } from '../tool.types';
import { GoogleAuthService } from '../client-ops/google-auth.service';
import { GoogleDriveService } from '../client-ops/google-drive.service';

/**
 * Lê o texto de uma transcrição específica (fileId vindo de
 * listarReunioesCliente). O texto volta truncado em ~12k chars — suficiente
 * pra resumir decisões e pendências sem estourar o contexto.
 */
@Injectable()
export class LerTranscricaoReuniaoTool implements AiTool {
  private readonly logger = new Logger(LerTranscricaoReuniaoTool.name);

  readonly name = 'lerTranscricaoReuniao';
  readonly description =
    'Lê o conteúdo de UMA transcrição de reunião (use o fileId retornado por listarReunioesCliente). Depois de ler, responda com um RESUMO (decisões, pendências, próximos passos) — nunca cole a transcrição inteira pro cliente.';
  readonly parameters = {
    type: 'object',
    additionalProperties: false,
    required: ['fileId'],
    properties: {
      fileId: {
        type: 'string',
        description: 'ID do arquivo no Drive, vindo de listarReunioesCliente.',
        minLength: 10,
        maxLength: 120,
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
    const fileId = String(input.fileId ?? '').trim();

    try {
      const { title, text, truncated } = await this.drive.getFileText(fileId);
      this.logger.log(
        `lerTranscricaoReuniao "${title}" (${text.length} chars, run=${ctx.runId})`,
      );
      return {
        output: {
          ok: true,
          titulo: title,
          truncada: truncated,
          conteudo: text,
        },
      };
    } catch (err: any) {
      const status = err?.response?.status;
      return {
        output: {
          ok: false,
          error:
            status === 404
              ? 'Arquivo não encontrado — use um fileId retornado por listarReunioesCliente.'
              : `Falha ao ler transcrição: ${err?.message}`,
        },
      };
    }
  }
}
