import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';

const MAX_OUTPUT_CHARS = 6_000;

/**
 * Consulta READ-ONLY à instância n8n do CLIENTE (cada cliente tem a sua,
 * provisionada pela Bravy). URL e API key vêm dos custom fields do Hoppe.
 * O sistema NÃO depende de n8n — o n8n aqui é só alvo de consulta, pra
 * Sofia responder "minha automação rodou?" sem humano no meio.
 */
@Injectable()
export class N8nClientService {
  private readonly logger = new Logger(N8nClientService.name);

  private async get<T>(
    baseUrl: string,
    apiKey: string,
    path: string,
  ): Promise<T> {
    const resp = await axios.get<T>(`${baseUrl.replace(/\/$/, '')}${path}`, {
      headers: { 'X-N8N-API-KEY': apiKey },
      timeout: 15_000,
    });
    return resp.data;
  }

  async listWorkflows(baseUrl: string, apiKey: string): Promise<unknown> {
    const data = await this.get<{
      data: Array<{
        id: string;
        name: string;
        active: boolean;
        updatedAt?: string;
      }>;
    }>(baseUrl, apiKey, '/api/v1/workflows?limit=100');
    const workflows = data.data.map((w) => ({
      workflowId: w.id,
      nome: w.name,
      ativo: w.active,
    }));
    return N8nClientService.capOutput({
      total: workflows.length,
      workflows,
    });
  }

  async listExecutions(
    baseUrl: string,
    apiKey: string,
    options?: { workflowId?: string; status?: 'error' | 'success' | 'waiting' },
  ): Promise<unknown> {
    const params = new URLSearchParams({ limit: '15' });
    if (options?.workflowId) params.set('workflowId', options.workflowId);
    if (options?.status) params.set('status', options.status);

    const data = await this.get<{
      data: Array<{
        id: string | number;
        workflowId: string;
        status?: string;
        finished?: boolean;
        mode?: string;
        startedAt?: string;
        stoppedAt?: string;
      }>;
    }>(baseUrl, apiKey, `/api/v1/executions?${params.toString()}`);

    const executions = data.data.map((e) => ({
      executionId: String(e.id),
      workflowId: e.workflowId,
      status: e.status ?? (e.finished ? 'success' : 'unknown'),
      inicio: e.startedAt ?? null,
      fim: e.stoppedAt ?? null,
    }));
    return N8nClientService.capOutput({
      total: executions.length,
      executions,
    });
  }

  private static capOutput(value: unknown): unknown {
    const json = JSON.stringify(value);
    if (json.length <= MAX_OUTPUT_CHARS) return value;
    return {
      truncado: true,
      aviso: 'Resultado grande demais — filtre por workflowId ou status.',
      parcial: json.slice(0, MAX_OUTPUT_CHARS),
    };
  }
}
