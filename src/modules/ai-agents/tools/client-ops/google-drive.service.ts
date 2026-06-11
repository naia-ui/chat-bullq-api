import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { GoogleAuthService } from './google-auth.service';
import { DRIVE_MEET_RECORDINGS_FOLDER_ID } from './client-ops.constants';

export interface TranscriptFile {
  fileId: string;
  title: string;
  modifiedAt: string;
  source: 'meet-recordings' | 'pasta-projetos';
}

const MAX_TRANSCRIPT_CHARS = 12_000;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

/**
 * Busca e leitura de transcrições de reuniões no Google Drive via service
 * account (read-only). Duas fontes:
 *
 * 1. Pasta "Gravações Produtos Meet Recordings" — notas do Gemini, busca
 *    por nome do cliente no título do doc.
 * 2. Pasta "00. Projetos Implementação/[CLIENTE - TASKID]/Reuniões/
 *    Transcrições" — arquivos organizados por projeto (nome do arquivo
 *    nem sempre tem o cliente, então navega pela árvore de pastas).
 *
 * A service account só enxerga o que foi compartilhado com ela. Se a fonte 2
 * não estiver compartilhada ainda, degrada graciosamente pra fonte 1.
 */
@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly auth: GoogleAuthService,
  ) {}

  private async driveGet<T>(
    path: string,
    params: Record<string, string>,
  ): Promise<T> {
    const token = await this.auth.getDriveToken();
    const resp = await axios.get<T>(`${DRIVE_API}${path}`, {
      params,
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15_000,
    });
    return resp.data;
  }

  private static escapeQuery(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  }

  async searchTranscripts(
    clientName: string,
    limit = 10,
  ): Promise<{ files: TranscriptFile[]; warnings: string[] }> {
    const warnings: string[] = [];
    const files: TranscriptFile[] = [];
    const name = GoogleDriveService.escapeQuery(clientName.trim());
    const meetFolder =
      this.config.get<string>('DRIVE_MEET_FOLDER_ID') ??
      DRIVE_MEET_RECORDINGS_FOLDER_ID;

    // Fonte 1: Meet Recordings (título contém o cliente)
    try {
      const data = await this.driveGet<{
        files: Array<{ id: string; name: string; modifiedTime: string }>;
      }>('/files', {
        q: `'${meetFolder}' in parents and name contains '${name}' and trashed=false`,
        orderBy: 'modifiedTime desc',
        pageSize: String(limit),
        fields: 'files(id,name,modifiedTime)',
      });
      files.push(
        ...data.files.map((f) => ({
          fileId: f.id,
          title: f.name,
          modifiedAt: f.modifiedTime,
          source: 'meet-recordings' as const,
        })),
      );
    } catch (err: any) {
      warnings.push(`Falha na busca em Meet Recordings: ${err?.message}`);
    }

    // Fonte 2: pasta de projetos (navega [CLIENTE]/Reuniões/Transcrições)
    try {
      const folder = await this.driveGet<{
        files: Array<{ id: string; name: string }>;
      }>('/files', {
        q: `mimeType='application/vnd.google-apps.folder' and name contains '${name}' and trashed=false`,
        pageSize: '5',
        fields: 'files(id,name)',
      });
      const clientFolder = folder.files.find((f) =>
        /-\s*[0-9a-f]{8}/i.test(f.name),
      ) ?? folder.files[0];

      if (clientFolder) {
        let parentId = clientFolder.id;
        for (const sub of ['Reuniões', 'Transcrições']) {
          const subData = await this.driveGet<{
            files: Array<{ id: string }>;
          }>('/files', {
            q: `'${parentId}' in parents and mimeType='application/vnd.google-apps.folder' and name='${GoogleDriveService.escapeQuery(sub)}' and trashed=false`,
            pageSize: '1',
            fields: 'files(id)',
          });
          if (!subData.files[0]) {
            parentId = '';
            break;
          }
          parentId = subData.files[0].id;
        }
        if (parentId) {
          const docs = await this.driveGet<{
            files: Array<{ id: string; name: string; modifiedTime: string }>;
          }>('/files', {
            q: `'${parentId}' in parents and trashed=false`,
            orderBy: 'modifiedTime desc',
            pageSize: String(limit),
            fields: 'files(id,name,modifiedTime)',
          });
          files.push(
            ...docs.files.map((f) => ({
              fileId: f.id,
              title: f.name,
              modifiedAt: f.modifiedTime,
              source: 'pasta-projetos' as const,
            })),
          );
        }
      }
    } catch (err: any) {
      warnings.push(
        `Pasta de projetos indisponível (provavelmente não compartilhada com a service account): ${err?.message}`,
      );
    }

    files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));
    return { files: files.slice(0, limit), warnings };
  }

  /** Baixa o texto de uma transcrição (Google Doc exportado ou arquivo texto). */
  async getFileText(
    fileId: string,
  ): Promise<{ title: string; text: string; truncated: boolean }> {
    const meta = await this.driveGet<{ name: string; mimeType: string }>(
      `/files/${encodeURIComponent(fileId)}`,
      { fields: 'name,mimeType' },
    );

    const token = await this.auth.getDriveToken();
    const isGoogleDoc = meta.mimeType === 'application/vnd.google-apps.document';
    const url = isGoogleDoc
      ? `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`
      : `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;

    const resp = await axios.get<string>(url, {
      headers: { Authorization: `Bearer ${token}` },
      responseType: 'text',
      timeout: 20_000,
      // transcrição grande não pode estourar a memória nem o contexto
      maxContentLength: 5 * 1024 * 1024,
    });

    const full = String(resp.data ?? '');
    const truncated = full.length > MAX_TRANSCRIPT_CHARS;
    return {
      title: meta.name,
      text: truncated ? full.slice(0, MAX_TRANSCRIPT_CHARS) : full,
      truncated,
    };
  }
}
