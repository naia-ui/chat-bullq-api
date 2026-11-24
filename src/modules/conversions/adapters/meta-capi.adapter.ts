import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConversionsConfigService } from '../conversions.config';

/**
 * API de Conversões da Meta (CAPI).
 *
 * Avisa a Meta, depois do fato, que um contato converteu fora do site — na
 * conversa de WhatsApp. O que sai no envio:
 *
 *   event_name     neutro (Lead | Schedule | Contrato), nunca a área
 *   event_time     quando o fato aconteceu, sem remendo de data
 *   event_id       id da linha da fila — é o que faz a Meta deduplicar
 *   user_data      SÓ o identificador: `ctwa_clid`, `fbc` ou `ph` em SHA-256
 *   custom_data    valor, somente quando CONVERSIONS_SEND_REAL_VALUE está on
 *
 * Nome, e-mail, telefone em claro, texto da conversa e fato do caso não
 * entram no envio em nenhuma hipótese.
 */

export interface MetaSendInput {
  eventId: string;
  eventName: string;
  occurredAt: Date;
  matchKind: string;
  matchValue: string;
  value?: number | null;
  currency?: string;
}

export interface PlatformSendResult {
  ok: boolean;
  /** Corpo montado — guardado na pré-visualização e na auditoria. */
  request: Record<string, unknown>;
  response?: Record<string, unknown>;
  errorMessage?: string;
  /** true quando o erro é transitório e vale reprocessar. */
  retryable?: boolean;
}

@Injectable()
export class MetaCapiAdapter {
  private readonly logger = new Logger(MetaCapiAdapter.name);

  constructor(private readonly config: ConversionsConfigService) {}

  /** Monta o corpo do envio sem chamar a Meta (usado na simulação e no teste). */
  buildPayload(input: MetaSendInput): Record<string, unknown> {
    const settings = this.config.meta;
    const userData: Record<string, unknown> = {};

    if (input.matchKind === 'phone_hash') {
      // A Meta espera o telefone normalizado em SHA-256; o hash já vem
      // pronto da camada de origem.
      userData.ph = [input.matchValue];
    } else if (input.matchKind === 'ctwa_clid') {
      userData.ctwa_clid = input.matchValue;
    } else if (input.matchKind === 'fbclid') {
      // Formato que a Meta pede para o clique: fb.1.<timestamp>.<fbclid>
      const seconds = Math.floor(input.occurredAt.getTime() / 1000);
      userData.fbc = `fb.1.${seconds}.${input.matchValue}`;
    }

    const event: Record<string, unknown> = {
      event_name: input.eventName,
      event_time: Math.floor(input.occurredAt.getTime() / 1000),
      event_id: input.eventId,
      action_source: settings.actionSource,
      user_data: userData,
    };

    if (input.value != null) {
      event.custom_data = {
        value: Number(input.value),
        currency: input.currency ?? 'BRL',
      };
    }

    const payload: Record<string, unknown> = { data: [event] };
    if (settings.testEventCode) {
      payload.test_event_code = settings.testEventCode;
    }
    return payload;
  }

  async send(input: MetaSendInput): Promise<PlatformSendResult> {
    const settings = this.config.meta;
    const payload = this.buildPayload(input);

    if (!settings.enabled || !settings.pixelId || !settings.token) {
      return {
        ok: false,
        request: payload,
        errorMessage: this.config.platformOffReason('META') ?? 'Meta desligada',
        retryable: true,
      };
    }

    const url = `https://graph.facebook.com/${settings.apiVersion}/${settings.pixelId}/events`;

    try {
      const response = await axios.post(
        url,
        { ...payload, access_token: settings.token },
        { timeout: 15_000 },
      );
      return {
        ok: true,
        request: payload,
        response: response.data as Record<string, unknown>,
      };
    } catch (err) {
      const { message, retryable, body } = describeAxiosError(err);
      this.logger.warn(
        `capi_send_failed event=${input.eventId} name=${input.eventName}: ${message}`,
      );
      return {
        ok: false,
        request: payload,
        response: body,
        errorMessage: message,
        retryable,
      };
    }
  }
}

/**
 * Traduz o erro em mensagem curta e decide se vale reprocessar. 4xx de
 * validação não vale — a mesma linha falharia de novo; 429 e 5xx valem.
 */
export function describeAxiosError(err: unknown): {
  message: string;
  retryable: boolean;
  body?: Record<string, unknown>;
} {
  if (axios.isAxiosError(err)) {
    const status = err.response?.status;
    const body = err.response?.data as Record<string, unknown> | undefined;
    const detail =
      (body?.error as { message?: string } | undefined)?.message ??
      (typeof body?.message === 'string' ? body.message : undefined) ??
      err.message;
    const retryable = !status || status === 429 || status >= 500;
    return {
      message: `${status ?? 'sem resposta'}: ${String(detail).slice(0, 400)}`,
      retryable,
      body,
    };
  }
  return { message: (err as Error).message ?? 'erro desconhecido', retryable: true };
}
