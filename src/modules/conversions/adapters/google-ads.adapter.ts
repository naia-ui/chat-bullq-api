import { Injectable, Logger } from '@nestjs/common';
import axios from 'axios';
import { ConversionsConfigService } from '../conversions.config';
import { describeAxiosError, PlatformSendResult } from './meta-capi.adapter';

/**
 * Importação de conversão offline por clique no Google Ads.
 *
 * O Google casa a conversão pelo identificador do clique (gclid, gbraid ou
 * wbraid) — nenhum dado pessoal sai daqui. Sem identificador não há envio:
 * a camada de origem já marca a linha como "aguardando gclid".
 *
 * Importante: **não** mandamos o cabeçalho `login-customer-id`. A conta é
 * acessada direto pelo seu próprio id (decisão registrada da titular).
 *
 * `validateOnly` liga a conferência sem gravar — é o equivalente do
 * "--validar": o Google responde se aceitaria, e nada entra na conta.
 */

export interface GoogleSendInput {
  eventName: string;
  occurredAt: Date;
  matchKind: string;
  matchValue: string;
  value?: number | null;
  currency?: string;
  validateOnly?: boolean;
}

@Injectable()
export class GoogleAdsAdapter {
  private readonly logger = new Logger(GoogleAdsAdapter.name);
  private accessToken: { value: string; expiresAt: number } | null = null;

  constructor(private readonly config: ConversionsConfigService) {}

  /** Monta o corpo do envio sem chamar o Google. */
  buildPayload(input: GoogleSendInput): Record<string, unknown> {
    const settings = this.config.google;
    const conversion: Record<string, unknown> = {
      conversionAction: settings.actions[input.eventName] ?? null,
      conversionDateTime: formatGoogleDateTime(input.occurredAt),
    };

    if (input.matchKind === 'gclid') conversion.gclid = input.matchValue;
    if (input.matchKind === 'gbraid') conversion.gbraid = input.matchValue;
    if (input.matchKind === 'wbraid') conversion.wbraid = input.matchValue;

    if (input.value != null) {
      conversion.conversionValue = Number(input.value);
      conversion.currencyCode = input.currency ?? 'BRL';
    }

    return {
      conversions: [conversion],
      partialFailure: true,
      validateOnly: input.validateOnly ?? false,
    };
  }

  async send(input: GoogleSendInput): Promise<PlatformSendResult> {
    const settings = this.config.google;
    const payload = this.buildPayload(input);

    const off = this.config.platformOffReason('GOOGLE');
    if (off || !settings.enabled) {
      return {
        ok: false,
        request: payload,
        errorMessage: off ?? 'Google desligado',
        retryable: true,
      };
    }

    const action = settings.actions[input.eventName];
    if (!action) {
      return {
        ok: false,
        request: payload,
        errorMessage: `sem ação de conversão configurada para "${input.eventName}" (GOOGLE_ADS_ACTION_*)`,
        // Falta de configuração: reprocessar depois de configurar resolve.
        retryable: true,
      };
    }

    let token: string;
    try {
      token = await this.getAccessToken();
    } catch (err) {
      const { message, retryable } = describeAxiosError(err);
      return {
        ok: false,
        request: payload,
        errorMessage: `token: ${message}`,
        retryable,
      };
    }

    const url =
      `https://googleads.googleapis.com/${settings.apiVersion}` +
      `/customers/${settings.customerId}:uploadClickConversions`;

    try {
      const response = await axios.post(url, payload, {
        timeout: 20_000,
        headers: {
          Authorization: `Bearer ${token}`,
          'developer-token': settings.developerToken as string,
          'Content-Type': 'application/json',
        },
      });
      const body = response.data as Record<string, unknown>;
      // partialFailure: o Google responde 200 e descreve a recusa dentro do
      // corpo. Sem olhar aqui, uma conversão recusada passaria por enviada.
      const failure = body?.partialFailureError as
        | { message?: string }
        | undefined;
      if (failure) {
        return {
          ok: false,
          request: payload,
          response: body,
          errorMessage: `recusada: ${String(failure.message ?? '').slice(0, 400)}`,
          retryable: false,
        };
      }
      return { ok: true, request: payload, response: body };
    } catch (err) {
      const { message, retryable, body } = describeAxiosError(err);
      this.logger.warn(
        `google_upload_failed name=${input.eventName} kind=${input.matchKind}: ${message}`,
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

  /** Access token a partir do refresh token, com reuso enquanto vale. */
  private async getAccessToken(): Promise<string> {
    const now = Date.now();
    if (this.accessToken && this.accessToken.expiresAt > now + 60_000) {
      return this.accessToken.value;
    }
    const settings = this.config.google;
    const response = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: settings.clientId as string,
        client_secret: settings.clientSecret as string,
        refresh_token: settings.refreshToken as string,
        grant_type: 'refresh_token',
      }),
      { timeout: 15_000 },
    );
    const data = response.data as { access_token: string; expires_in: number };
    this.accessToken = {
      value: data.access_token,
      expiresAt: now + (data.expires_in ?? 3600) * 1000,
    };
    return this.accessToken.value;
  }
}

/**
 * Formato que o Google exige: `yyyy-MM-dd HH:mm:ss±hh:mm`. O fuso vai
 * explícito; sem ele o Google recusa o envio.
 */
export function formatGoogleDateTime(
  date: Date,
  offsetMinutes = -180, // America/Sao_Paulo, sem horário de verão
): string {
  const shifted = new Date(date.getTime() + offsetMinutes * 60_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const abs = Math.abs(offsetMinutes);
  return (
    `${shifted.getUTCFullYear()}-${pad(shifted.getUTCMonth() + 1)}-${pad(shifted.getUTCDate())} ` +
    `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}
