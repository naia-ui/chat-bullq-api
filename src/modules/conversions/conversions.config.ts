import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DEFAULT_GRACE_HOURS } from './conversions.constants';

/**
 * Configuração do envio de conversão, lida do ambiente (Coolify).
 *
 * Tudo desligado de fábrica. O envio real exige, ao mesmo tempo:
 *   CONVERSIONS_ENABLED=true          chave geral
 *   META_CAPI_ENABLED=true            e credenciais da Meta
 *   GOOGLE_ADS_ENABLED=true           e credenciais do Google
 *   CONVERSIONS_DRY_RUN=false         sai de simulação
 *
 * Com qualquer uma dessas desligada, a fila continua enchendo e nada sai:
 * nenhuma conversão é perdida, nenhuma é enviada por engano.
 *
 * Nenhum segredo tem valor padrão. Credencial ausente = plataforma tratada
 * como desligada, com motivo no relatório.
 */

export interface MetaCapiSettings {
  enabled: boolean;
  pixelId: string | null;
  token: string | null;
  apiVersion: string;
  /** Código de teste do Gerenciador de Eventos; remover depois de conferir. */
  testEventCode: string | null;
  /** [VERIFICAR] valor aceito pela Meta para conversa de WhatsApp. */
  actionSource: string;
}

export interface GoogleAdsSettings {
  enabled: boolean;
  /** Só dígitos, sem traços. */
  customerId: string | null;
  developerToken: string | null;
  clientId: string | null;
  clientSecret: string | null;
  refreshToken: string | null;
  apiVersion: string;
  /**
   * Ação de conversão por nome de evento, no formato
   * `customers/<id>/conversionActions/<id>`.
   * GOOGLE_ADS_ACTION_LEAD / _SCHEDULE / _CONTRACT
   */
  actions: Record<string, string | null>;
}

@Injectable()
export class ConversionsConfigService {
  private readonly logger = new Logger(ConversionsConfigService.name);

  constructor(private readonly config: ConfigService) {}

  /** Chave geral. Falso = nada sai, a fila só acumula. */
  get enabled(): boolean {
    return this.bool('CONVERSIONS_ENABLED', false);
  }

  /** Simulação: monta o envio, grava a pré-visualização e não chama ninguém. */
  get dryRun(): boolean {
    return this.bool('CONVERSIONS_DRY_RUN', true);
  }

  get graceHours(): number {
    const raw = Number(this.config.get<string>('CONVERSIONS_GRACE_HOURS'));
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_GRACE_HOURS;
    return raw;
  }

  /**
   * Enviar o valor real do contrato. Desligado de fábrica: o valor de um
   * contrato de honorários é informação do escritório, e a otimização da
   * plataforma funciona com evento sem valor.
   */
  get sendRealValue(): boolean {
    return this.bool('CONVERSIONS_SEND_REAL_VALUE', false);
  }

  get meta(): MetaCapiSettings {
    const pixelId = this.str('CAPI_PIXEL_ID') ?? this.str('META_PIXEL_ID');
    const token = this.str('CAPI_TOKEN');
    return {
      enabled: this.bool('META_CAPI_ENABLED', false) && !!pixelId && !!token,
      pixelId,
      token,
      apiVersion: this.str('META_API_VERSION') ?? 'v21.0',
      testEventCode: this.str('CAPI_TEST_EVENT_CODE'),
      actionSource: this.str('CAPI_ACTION_SOURCE') ?? 'business_messaging',
    };
  }

  get google(): GoogleAdsSettings {
    const customerId = (this.str('GOOGLE_ADS_CUSTOMER_ID') ?? '').replace(
      /\D/g,
      '',
    );
    const developerToken = this.str('GOOGLE_ADS_DEVELOPER_TOKEN');
    const clientId = this.str('GOOGLE_ADS_CLIENT_ID');
    const clientSecret = this.str('GOOGLE_ADS_CLIENT_SECRET');
    const refreshToken = this.str('GOOGLE_ADS_REFRESH_TOKEN');
    return {
      enabled:
        this.bool('GOOGLE_ADS_ENABLED', false) &&
        !!customerId &&
        !!developerToken &&
        !!clientId &&
        !!clientSecret &&
        !!refreshToken,
      customerId: customerId || null,
      developerToken,
      clientId,
      clientSecret,
      refreshToken,
      // [VERIFICAR] conferir a versão vigente da Google Ads API antes de ligar.
      apiVersion: this.str('GOOGLE_ADS_API_VERSION') ?? 'v21',
      actions: {
        Lead: this.str('GOOGLE_ADS_ACTION_LEAD'),
        Schedule: this.str('GOOGLE_ADS_ACTION_SCHEDULE'),
        Contrato: this.str('GOOGLE_ADS_ACTION_CONTRACT'),
      },
    };
  }

  /** Motivo pelo qual a plataforma está fora, para o relatório. */
  platformOffReason(platform: 'META' | 'GOOGLE'): string | null {
    if (!this.enabled) return 'CONVERSIONS_ENABLED desligado';
    if (platform === 'META') {
      const m = this.meta;
      if (!m.pixelId) return 'CAPI_PIXEL_ID ausente';
      if (!m.token) return 'CAPI_TOKEN ausente';
      if (!m.enabled) return 'META_CAPI_ENABLED desligado';
      return null;
    }
    const g = this.google;
    if (!g.customerId) return 'GOOGLE_ADS_CUSTOMER_ID ausente';
    if (!g.developerToken) return 'GOOGLE_ADS_DEVELOPER_TOKEN ausente';
    if (!g.refreshToken) return 'GOOGLE_ADS_REFRESH_TOKEN ausente';
    if (!g.enabled) return 'GOOGLE_ADS_ENABLED desligado';
    return null;
  }

  private bool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    return ['1', 'true', 'yes', 'sim'].includes(String(raw).toLowerCase());
  }

  private str(key: string): string | null {
    const raw = this.config.get<string>(key);
    const value = (raw ?? '').trim();
    return value || null;
  }
}
