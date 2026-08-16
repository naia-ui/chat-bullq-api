import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { Channel, ChannelType, Prisma } from '@prisma/client';
import { PrismaService } from '../../../../database/prisma.service';
import { ZappfyHttpClient } from './zappfy.http-client';
import { EmailAlertService } from '../../../notifications/email-alert.service';
import {
  ZAPPFY_HEALTH_ALERT_COOLDOWN_MINUTES_DEFAULT,
  ZAPPFY_HEALTH_CHECK_PATTERN_DEFAULT,
  ZAPPFY_HEALTH_JOB,
  ZAPPFY_HEALTH_QUEUE,
} from './zappfy-health.constants';

/**
 * Monitora proativamente a conexão de cada canal WHATSAPP_ZAPPFY. A sessão
 * do WhatsApp pareada via QR Code no Zappfy/Uazapi pode cair sozinha
 * (celular sem internet, logout manual, limite de aparelhos, etc.) sem
 * nenhum aviso — até este cron, a única forma de descobrir era abrir o
 * painel do Zappfy manualmente e reparar que o status virou "Desconectado".
 *
 * Reusa o mesmo endpoint que o botão "Testar conexão" da tela de canais
 * chama sob demanda (`ZappfyHttpClient.getInstanceStatus`, ver
 * `ChannelsService.testConnection`) — só que em loop automático + alerta.
 *
 * Não alerta pelo próprio WhatsApp de propósito (ovo-galinha: é exatamente
 * o canal que pode estar fora do ar quando o alerta precisa sair) — manda
 * e-mail via EmailAlertService/Resend, que é independente da sessão caída.
 */
@Processor(ZAPPFY_HEALTH_QUEUE, { concurrency: 1 })
export class ZappfyConnectionHealthCron
  extends WorkerHost
  implements OnModuleInit
{
  private readonly logger = new Logger(ZappfyConnectionHealthCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly httpClient: ZappfyHttpClient,
    private readonly emailAlert: EmailAlertService,
    private readonly config: ConfigService,
    @InjectQueue(ZAPPFY_HEALTH_QUEUE) private readonly healthQueue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const pattern =
      this.config.get<string>('ZAPPFY_HEALTH_CHECK_PATTERN') ||
      ZAPPFY_HEALTH_CHECK_PATTERN_DEFAULT;
    try {
      await this.healthQueue.add(
        ZAPPFY_HEALTH_JOB,
        {},
        {
          repeat: { pattern },
          jobId: 'zappfy-health-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`zappfy_health_cron_registered pattern=${pattern}`);
    } catch (err) {
      this.logger.error(
        `Falha registrando cron de saúde do Zappfy: ${(err as Error).message}`,
      );
    }
  }

  async process(_job: Job): Promise<{ channels: number; down: number }> {
    const channels = await this.prisma.channel.findMany({
      where: {
        type: ChannelType.WHATSAPP_ZAPPFY,
        isActive: true,
        deletedAt: null,
      },
    });
    if (channels.length === 0) return { channels: 0, down: 0 };

    let down = 0;
    for (const channel of channels) {
      try {
        const connected = await this.checkChannel(channel);
        if (!connected) down++;
      } catch (err: any) {
        // Erro ao checar (timeout, API do Zappfy fora do ar) não é a mesma
        // coisa que "sessão desconectada comprovada" — loga e segue pro
        // próximo canal sem marcar como down, pra não gerar falso-positivo
        // por instabilidade do provedor em vez da sessão em si.
        this.logger.error(
          `Falha ao checar status do canal Zappfy ${channel.id}: ${err?.message ?? err}`,
        );
      }
    }
    if (down > 0) {
      this.logger.warn(`Zappfy health: ${down}/${channels.length} canal(is) desconectado(s).`);
    }
    return { channels: channels.length, down };
  }

  /** Retorna true se conectado. Efeitos colaterais: alerta por e-mail + watermark no config. */
  private async checkChannel(channel: Channel): Promise<boolean> {
    const status = await this.httpClient.getInstanceStatus(channel);
    const connected = this.isConnected(status);
    const cfg = (channel.config ?? {}) as Record<string, any>;

    if (connected) {
      // Reconectou: se havia um alerta de queda ativo, avisa a volta e
      // limpa o watermark pra próxima queda começar do zero.
      if (cfg.zappfyDisconnectedSince) {
        await this.notifyReconnected(channel, cfg);
        await this.updateHealthWatermark(channel, {
          zappfyDisconnectedSince: null,
          zappfyLastAlertAt: null,
        });
      }
      return true;
    }

    const cooldownMinutes = Number(
      this.config.get('ZAPPFY_HEALTH_ALERT_COOLDOWN_MINUTES') ??
        ZAPPFY_HEALTH_ALERT_COOLDOWN_MINUTES_DEFAULT,
    );
    const lastAlertAt = cfg.zappfyLastAlertAt
      ? new Date(cfg.zappfyLastAlertAt)
      : null;
    const dueForAlert =
      !lastAlertAt ||
      Date.now() - lastAlertAt.getTime() >= cooldownMinutes * 60 * 1000;

    if (dueForAlert) {
      await this.notifyDisconnected(channel, status);
      await this.updateHealthWatermark(channel, {
        zappfyDisconnectedSince:
          cfg.zappfyDisconnectedSince ?? new Date().toISOString(),
        zappfyLastAlertAt: new Date().toISOString(),
      });
    }

    return false;
  }

  /**
   * Shape real observado em produção (GET /instance/status, testado direto
   * contra a API do Zappfy em 16/08/2026):
   *   { instance: { status: "connected", ... }, status: { connected: true, loggedIn: true, ... } }
   * `status` aqui é um OBJETO aninhado, não a string simples que o parser
   * original (copiado de ChannelsService.testConnection) esperava — por
   * isso os dois checks abaixo priorizam esse formato real antes de cair
   * nos fallbacks mais genéricos.
   */
  private isConnected(raw: any): boolean {
    const nestedConnected = raw?.status?.connected;
    if (typeof nestedConnected === 'boolean') return nestedConnected;

    const instanceStatus = raw?.instance?.status;
    if (typeof instanceStatus === 'string') {
      return this.looksConnected(instanceStatus);
    }

    // Fallbacks pro formato mais simples (outros firmwares Uazapi variam).
    const rawState = raw?.state;
    const statusStr =
      typeof rawState === 'string'
        ? rawState
        : typeof rawState === 'object' && rawState?.status
          ? String(rawState.status)
          : typeof raw?.status === 'string'
            ? raw.status
            : undefined;
    if (statusStr) return this.looksConnected(statusStr);

    // Nenhum campo reconhecível — não é prova de queda, só de resposta em
    // formato inesperado. Assume conectado (mesma postura defensiva do
    // catch em process(): erro/formato estranho na leitura não pode virar
    // alerta falso — só uma queda CONFIRMADA dispara e-mail).
    this.logger.warn(
      `Resposta de status do Zappfy em formato não reconhecido: ${JSON.stringify(raw)}`,
    );
    return true;
  }

  private looksConnected(statusStr: string): boolean {
    const normalized = statusStr.toLowerCase();
    return normalized.includes('connect') && !normalized.includes('disconnect');
  }

  private async notifyDisconnected(channel: Channel, status: any): Promise<void> {
    const to = this.config.get<string>('ZAPPFY_HEALTH_ALERT_EMAIL_TO');
    if (!to) {
      this.logger.warn(
        `Canal Zappfy ${channel.id} (${channel.name}) desconectado, mas ZAPPFY_HEALTH_ALERT_EMAIL_TO não configurado — sem e-mail enviado.`,
      );
      return;
    }
    const cfg = (channel.config ?? {}) as Record<string, any>;
    const phone = cfg.number || cfg.phone || '?';
    await this.emailAlert.send({
      to,
      subject: `⚠️ WhatsApp desconectado — ${channel.name}`,
      html: `
        <p>O canal <b>${this.escapeHtml(channel.name)}</b> (número ${this.escapeHtml(String(phone))}) do Justine OS está <b>desconectado</b> desde a última checagem.</p>
        <p>Nenhum lead novo está sendo recebido por esse número enquanto isso não for corrigido.</p>
        <p><b>Como resolver:</b> abra o painel do Zappfy/Uazapi, gere um novo QR Code e escaneie novamente no celular vinculado a esse número.</p>
        <p style="color:#888;font-size:12px">Status bruto retornado pela API: <code>${this.escapeHtml(JSON.stringify(status))}</code></p>
      `,
    });
    this.logger.warn(
      `Canal Zappfy ${channel.id} (${channel.name}) desconectado — alerta disparado para ${to}.`,
    );
  }

  private async notifyReconnected(
    channel: Channel,
    cfg: Record<string, any>,
  ): Promise<void> {
    const to = this.config.get<string>('ZAPPFY_HEALTH_ALERT_EMAIL_TO');
    if (!to) return;
    const downSince = cfg.zappfyDisconnectedSince
      ? new Date(cfg.zappfyDisconnectedSince)
      : null;
    const durationMin = downSince
      ? Math.round((Date.now() - downSince.getTime()) / 60000)
      : undefined;
    await this.emailAlert.send({
      to,
      subject: `✅ WhatsApp reconectado — ${channel.name}`,
      html: `
        <p>O canal <b>${this.escapeHtml(channel.name)}</b> voltou a ficar <b>conectado</b>.</p>
        ${durationMin !== undefined ? `<p>Ficou desconectado por aproximadamente ${durationMin} minuto(s).</p>` : ''}
      `,
    });
    this.logger.log(`Canal Zappfy ${channel.id} (${channel.name}) reconectado.`);
  }

  private async updateHealthWatermark(
    channel: Channel,
    patch: Record<string, any>,
  ): Promise<void> {
    await this.prisma.channel.update({
      where: { id: channel.id },
      data: {
        config: {
          ...(channel.config as Prisma.JsonObject),
          ...patch,
        } as Prisma.InputJsonValue,
      },
    });
  }

  private escapeHtml(str: string): string {
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
}
