import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface SendAlertEmailParams {
  to: string | string[];
  subject: string;
  html: string;
}

/**
 * Envio de e-mail transacional via Resend (https://resend.com), usado hoje
 * pra alertas operacionais internos (ex.: canal WhatsApp/Zappfy caiu — ver
 * ZappfyConnectionHealthCron). Genérico o suficiente pra qualquer outro
 * alerta futuro (token do Gmail expirado, fila travada, etc.) reusar —
 * não é o canal de e-mail do produto (aquele é o adapter GMAIL em
 * channel-hub/adapters/gmail, que fala com a caixa do CLIENTE).
 *
 * Sem RESEND_API_KEY configurada, loga um warning e retorna false — nunca
 * lança. Alerta é best-effort: não pode derrubar o processo que o disparou
 * (ex.: o próprio cron de saúde não pode falhar por causa do e-mail).
 */
@Injectable()
export class EmailAlertService {
  private readonly logger = new Logger(EmailAlertService.name);
  private static readonly RESEND_API_URL = 'https://api.resend.com/emails';

  constructor(private readonly config: ConfigService) {}

  async send(params: SendAlertEmailParams): Promise<boolean> {
    const apiKey = this.config.get<string>('RESEND_API_KEY');
    if (!apiKey) {
      this.logger.warn(
        `RESEND_API_KEY não configurada — alerta "${params.subject}" não enviado (só logado).`,
      );
      return false;
    }
    const from =
      this.config.get<string>('RESEND_FROM_EMAIL') ||
      'Justine OS <onboarding@resend.dev>';

    try {
      await axios.post(
        EmailAlertService.RESEND_API_URL,
        {
          from,
          to: Array.isArray(params.to) ? params.to : [params.to],
          subject: params.subject,
          html: params.html,
        },
        {
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 15000,
        },
      );
      this.logger.log(`Alerta "${params.subject}" enviado para ${params.to}.`);
      return true;
    } catch (err: any) {
      this.logger.error(
        `Falha ao enviar e-mail via Resend ("${params.subject}"): ${
          err?.response?.data?.message || err?.message || err
        }`,
      );
      return false;
    }
  }
}
