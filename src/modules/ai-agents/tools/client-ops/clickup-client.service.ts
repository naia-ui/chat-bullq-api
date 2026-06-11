import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const CLICKUP_API = 'https://api.clickup.com/api/v2';
const MAX_OUTPUT_CHARS = 6_000;

/**
 * Consulta READ-ONLY ao ClickUp de um cliente usando o token dele (vindo
 * dos custom fields do Hoppe — nunca passa pelo LLM). As respostas são
 * compactadas pra caber no contexto do agente.
 */
@Injectable()
export class ClickUpClientService {
  private readonly logger = new Logger(ClickUpClientService.name);

  private async get<T>(token: string, path: string): Promise<T> {
    const resp = await axios.get<T>(`${CLICKUP_API}${path}`, {
      headers: { Authorization: token },
      timeout: 15_000,
    });
    return resp.data;
  }

  /** Spaces > Folders > Lists do workspace, compacto (nome + id). */
  async getWorkspaceTree(token: string, workspaceId: string): Promise<unknown> {
    const { spaces } = await this.get<{
      spaces: Array<{ id: string; name: string }>;
    }>(token, `/team/${workspaceId}/space`);

    const tree = await Promise.all(
      spaces.map(async (space) => {
        const [folderData, folderlessData] = await Promise.all([
          this.get<{
            folders: Array<{
              id: string;
              name: string;
              lists: Array<{ id: string; name: string; task_count?: number }>;
            }>;
          }>(token, `/space/${space.id}/folder`),
          this.get<{
            lists: Array<{ id: string; name: string; task_count?: number }>;
          }>(token, `/space/${space.id}/list`),
        ]);
        return {
          spaceId: space.id,
          space: space.name,
          folders: folderData.folders.map((f) => ({
            folderId: f.id,
            folder: f.name,
            lists: f.lists.map((l) => ({ listId: l.id, list: l.name })),
          })),
          listsSemFolder: folderlessData.lists.map((l) => ({
            listId: l.id,
            list: l.name,
          })),
        };
      }),
    );
    return ClickUpClientService.capOutput(tree);
  }

  /** Tasks de uma list (status, responsável, vencimento), compacto. */
  async getListTasks(
    token: string,
    listId: string,
    options?: { includeClosed?: boolean; page?: number },
  ): Promise<unknown> {
    const params = new URLSearchParams({
      page: String(options?.page ?? 0),
      ...(options?.includeClosed ? { include_closed: 'true' } : {}),
    });
    const data = await this.get<{
      tasks: Array<{
        id: string;
        name: string;
        status?: { status: string };
        assignees?: Array<{ username: string }>;
        due_date?: string | null;
        date_updated?: string;
      }>;
    }>(token, `/list/${listId}/task?${params.toString()}`);

    const tasks = data.tasks.map((t) => ({
      taskId: t.id,
      name: t.name,
      status: t.status?.status ?? null,
      responsaveis: (t.assignees ?? []).map((a) => a.username),
      vencimento: t.due_date
        ? new Date(Number(t.due_date)).toISOString().slice(0, 10)
        : null,
    }));
    return ClickUpClientService.capOutput({ total: tasks.length, tasks });
  }

  /** Detalhe de uma task (descrição truncada + custom fields preenchidos). */
  async getTask(token: string, taskId: string): Promise<unknown> {
    const t = await this.get<{
      id: string;
      name: string;
      description?: string;
      status?: { status: string };
      assignees?: Array<{ username: string }>;
      due_date?: string | null;
      custom_fields?: Array<{ name: string; value?: unknown }>;
      list?: { id: string; name: string };
    }>(token, `/task/${taskId}`);

    return ClickUpClientService.capOutput({
      taskId: t.id,
      name: t.name,
      list: t.list?.name ?? null,
      status: t.status?.status ?? null,
      responsaveis: (t.assignees ?? []).map((a) => a.username),
      vencimento: t.due_date
        ? new Date(Number(t.due_date)).toISOString().slice(0, 10)
        : null,
      descricao: (t.description ?? '').slice(0, 1_500),
      campos: (t.custom_fields ?? [])
        .filter((f) => f.value !== undefined && f.value !== null)
        .map((f) => ({ nome: f.name, valor: f.value })),
    });
  }

  /** Corta o JSON final pra não estourar o contexto do LLM. */
  private static capOutput(value: unknown): unknown {
    const json = JSON.stringify(value);
    if (json.length <= MAX_OUTPUT_CHARS) return value;
    return {
      truncado: true,
      aviso: `Resultado grande demais (${json.length} chars) — refine a consulta (use listId/taskId específico).`,
      parcial: json.slice(0, MAX_OUTPUT_CHARS),
    };
  }
}
