import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import {
  HOPPE_FIELD_AGENDA_PROJETO,
  HOPPE_FIELD_CLICKUP_API_TOKEN,
  HOPPE_FIELD_CLICKUP_WORKSPACE_ID,
  HOPPE_FIELD_GRUPO_WHATSAPP_JID,
  HOPPE_FIELD_N8N_API_KEY,
  HOPPE_FIELD_N8N_URL,
  HOPPE_LIST_AGENDA_CLIENTES,
  HOPPE_LIST_IMPLEMENTACOES,
} from './client-ops.constants';

export interface HoppeClientProject {
  taskId: string;
  shortId: string;
  name: string;
  clickupWorkspaceId: string | null;
  clickupApiToken: string | null;
  n8nUrl: string | null;
  n8nApiKey: string | null;
  whatsappGroupJid: string | null;
}

export interface HoppeClientLookup {
  project: HoppeClientProject | null;
  /** Nomes candidatos quando o match é ambíguo — a IA pergunta ao cliente. */
  candidates: string[];
}

interface HoppeTask {
  id: string;
  name: string;
  custom_fields?: Array<{ id: string; name: string; value: unknown }>;
}

const CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Cliente da API do Hoppe (gerenciador de projetos da Bravy). A list
 * Implementações tem uma task por cliente com custom fields de credenciais
 * (ClickUp token/workspace, n8n url/key, JID do grupo WhatsApp). Tokens de
 * clientes NUNCA vão pro LLM — ficam dentro dos services.
 *
 * Env required: HOPPE_API_KEY (HOPPE_BASE_URL opcional).
 */
@Injectable()
export class HoppeClientService {
  private readonly logger = new Logger(HoppeClientService.name);
  private tasksCache: { tasks: HoppeTask[]; fetchedAt: number } | null = null;

  constructor(private readonly config: ConfigService) {}

  private get baseUrl(): string {
    return (
      this.config.get<string>('HOPPE_BASE_URL') ??
      'https://hoppe-api.bravy.com.br'
    );
  }

  private get apiKey(): string | undefined {
    return this.config.get<string>('HOPPE_API_KEY');
  }

  isConfigured(): boolean {
    return !!this.apiKey;
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<T> {
    const resp = await axios.request<T>({
      method,
      url: `${this.baseUrl}${path}`,
      data: body,
      headers: {
        Authorization: this.apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
    return resp.data;
  }

  private async loadImplementationTasks(): Promise<HoppeTask[]> {
    if (
      this.tasksCache &&
      Date.now() - this.tasksCache.fetchedAt < CACHE_TTL_MS
    ) {
      return this.tasksCache.tasks;
    }
    const tasks: HoppeTask[] = [];
    for (let page = 0; page < 10; page++) {
      const data = await this.request<{ tasks: HoppeTask[] }>(
        'GET',
        `/api/v2/list/${HOPPE_LIST_IMPLEMENTACOES}/task?page=${page}`,
      );
      tasks.push(...(data.tasks ?? []));
      if ((data.tasks ?? []).length < 100) break;
    }
    this.tasksCache = { tasks, fetchedAt: Date.now() };
    return tasks;
  }

  private static normalize(s: string): string {
    return s
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9 ]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /**
   * Acha o projeto de implementação de um cliente pelo nome (parcial,
   * sem acento). Match ambíguo devolve candidatos em vez de chutar.
   */
  async findClientProject(clientName: string): Promise<HoppeClientLookup> {
    const tasks = await this.loadImplementationTasks();
    const query = HoppeClientService.normalize(clientName);
    if (!query) return { project: null, candidates: [] };

    const tokens = query.split(' ').filter((t) => t.length >= 2);
    const scored = tasks
      .map((t) => {
        const name = HoppeClientService.normalize(t.name);
        let score = 0;
        if (name === query) score += 10;
        if (name.includes(query)) score += 5;
        score += tokens.filter((tok) => name.includes(tok)).length;
        return { task: t, score };
      })
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score);

    if (scored.length === 0) return { project: null, candidates: [] };

    const best = scored[0];
    const ties = scored.filter((s) => s.score === best.score);
    if (ties.length > 1) {
      return {
        project: null,
        candidates: scored.slice(0, 5).map((s) => s.task.name),
      };
    }
    return { project: this.toProject(best.task), candidates: [] };
  }

  private toProject(task: HoppeTask): HoppeClientProject {
    const fields = new Map(
      (task.custom_fields ?? []).map((f) => [f.id, f.value]),
    );
    const str = (id: string): string | null => {
      const v = fields.get(id);
      return typeof v === 'string' && v.trim() ? v.trim() : null;
    };
    return {
      taskId: task.id,
      shortId: task.id.slice(0, 8),
      name: task.name,
      clickupWorkspaceId: str(HOPPE_FIELD_CLICKUP_WORKSPACE_ID),
      clickupApiToken: str(HOPPE_FIELD_CLICKUP_API_TOKEN),
      n8nUrl: str(HOPPE_FIELD_N8N_URL),
      n8nApiKey: str(HOPPE_FIELD_N8N_API_KEY),
      whatsappGroupJid: str(HOPPE_FIELD_GRUPO_WHATSAPP_JID),
    };
  }

  /**
   * Cria a task de reunião na list Agenda clientes seguindo a nomenclatura
   * padrão "Tema – Nome do projeto – HOPPEid" e vincula ao projeto.
   */
  async createMeetingTask(input: {
    project: HoppeClientProject;
    topic: string;
    startMs: number;
    endMs: number;
    description?: string;
  }): Promise<{ taskId: string; taskName: string }> {
    const taskName = `${input.topic} – ${input.project.name} – ${input.project.shortId}`;
    const created = await this.request<{ id?: string; task?: { id: string } }>(
      'POST',
      `/api/v2/list/${HOPPE_LIST_AGENDA_CLIENTES}/task`,
      {
        name: taskName,
        start_date: input.startMs,
        due_date: input.endMs,
        ...(input.description ? { description: input.description } : {}),
      },
    );
    const taskId = created.id ?? created.task?.id;
    if (!taskId) throw new Error('Hoppe não retornou id da task criada');

    try {
      await this.request(
        'POST',
        `/api/v2/task/${taskId}/field/${HOPPE_FIELD_AGENDA_PROJETO}`,
        { value: { relatedTaskIds: [input.project.taskId] } },
      );
    } catch (err: any) {
      // Vínculo é nice-to-have; a task em si já está criada.
      this.logger.warn(
        `Falha ao vincular task ${taskId} ao projeto ${input.project.taskId}: ${err?.message}`,
      );
    }
    return { taskId, taskName };
  }
}
