import { Processor, WorkerHost, InjectQueue } from '@nestjs/bullmq';
import { Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Job, Queue } from 'bullmq';
import { PrismaService } from '../../../database/prisma.service';
import { GoogleSheetsAuthService } from './google-sheets-auth.service';
import { GoogleSheetsClientService } from './google-sheets-client.service';
import {
  LEADS_SHEET_SYNC_JOB,
  LEADS_SHEET_SYNC_PATTERN_DEFAULT,
  LEADS_SHEET_SYNC_QUEUE,
  LEADS_SHEET_TAB_NAME_DEFAULT,
} from './leads-sheet-sync.constants';

const STATUS_LABEL: Record<string, string> = {
  OPEN: 'Aberto',
  WON: 'Ganho',
  LOST: 'Perdido',
};

/**
 * Snapshot completo: a cada tick, lê TODOS os cards não deletados de
 * pipelines não arquivados e reescreve a aba inteira da planilha do zero
 * (clear + write). Mais simples e auto-curativo que sync incremental
 * (nunca diverge, nunca acumula linha fantasma) — o custo de reescrever
 * tudo a cada vez é irrelevante pro volume de leads de um escritório.
 *
 * NOTA (multi-tenant): hoje sincroniza cards de TODAS as organizações
 * numa planilha só, via env global `GOOGLE_SHEETS_SPREADSHEET_ID`. Isso é
 * correto enquanto só existir uma organização real em produção (ver
 * AUDITORIA_JUSTINE_OS.md). Se um dia existir uma segunda organização de
 * verdade usando o sistema, isso precisa virar um campo por-organização
 * (ex.: `Organization.leadsSheetId`) em vez do env global.
 */
@Processor(LEADS_SHEET_SYNC_QUEUE, { concurrency: 1 })
export class LeadsSheetSyncCron extends WorkerHost implements OnModuleInit {
  private readonly logger = new Logger(LeadsSheetSyncCron.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly sheetsAuth: GoogleSheetsAuthService,
    private readonly sheetsClient: GoogleSheetsClientService,
    private readonly config: ConfigService,
    @InjectQueue(LEADS_SHEET_SYNC_QUEUE) private readonly queue: Queue,
  ) {
    super();
  }

  async onModuleInit(): Promise<void> {
    const pattern =
      this.config.get<string>('LEADS_SHEET_SYNC_PATTERN') ||
      LEADS_SHEET_SYNC_PATTERN_DEFAULT;
    try {
      await this.queue.add(
        LEADS_SHEET_SYNC_JOB,
        {},
        {
          repeat: { pattern },
          jobId: 'leads-sheet-sync-cron',
          removeOnComplete: 10,
          removeOnFail: 10,
        },
      );
      this.logger.log(`leads_sheet_sync_cron_registered pattern=${pattern}`);
    } catch (err) {
      this.logger.error(
        `Falha registrando cron de sync da planilha de leads: ${(err as Error).message}`,
      );
    }
  }

  async process(
    _job: Job,
  ): Promise<{ rows: number } | { skipped: true; reason: string }> {
    const spreadsheetId = this.config.get<string>(
      'GOOGLE_SHEETS_SPREADSHEET_ID',
    );
    if (!spreadsheetId || !this.sheetsAuth.hasCredentials()) {
      this.logger.warn(
        'GOOGLE_SHEETS_SPREADSHEET_ID ou GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON não configurados — sync pulado.',
      );
      return { skipped: true, reason: 'not_configured' };
    }

    const tabName =
      this.config.get<string>('GOOGLE_SHEETS_TAB_NAME') ||
      LEADS_SHEET_TAB_NAME_DEFAULT;

    const cards = await this.prisma.card.findMany({
      where: { pipeline: { archived: false } },
      include: {
        pipeline: { select: { name: true } },
        stage: { select: { name: true } },
        contact: { select: { name: true, phone: true, metadata: true } },
        assignedTo: { select: { name: true } },
      },
      orderBy: { updatedAt: 'desc' },
    });

    const header = [
      'Pipeline',
      'Etapa',
      'Contato',
      'Telefone',
      'Origem',
      'Status',
      'Valor',
      'Responsável',
      'Criado em',
      'Atualizado em',
      'Fechado em',
      'Motivo do fechamento',
    ];

    const rows: Array<Array<string | number>> = cards.map((c) => [
      this.sanitizeText(c.pipeline?.name ?? ''),
      this.sanitizeText(c.stage?.name ?? ''),
      this.sanitizeText(c.contact?.name ?? c.title ?? ''),
      this.sanitizeText(c.contact?.phone ?? ''),
      this.sanitizeText(this.originLabel(c.contact?.metadata)),
      STATUS_LABEL[c.status] ?? c.status,
      c.value ? Number(c.value) : '',
      this.sanitizeText(c.assignedTo?.name ?? ''),
      this.formatDate(c.createdAt),
      this.formatDate(c.updatedAt),
      c.closedAt ? this.formatDate(c.closedAt) : '',
      this.sanitizeText(c.closedReason ?? ''),
    ]);

    const dataRange = `${tabName}!A1:L${Math.max(rows.length + 1, 2)}`;

    try {
      // Cria a aba se ainda não existir (nunca toca em aba já existente
      // com outro propósito — ver GoogleSheetsClientService.ensureSheetExists).
      await this.sheetsClient.ensureSheetExists(spreadsheetId, tabName);
      // Limpa um range generoso primeiro (cobre encolhimento de linhas
      // desde o último sync), depois escreve header + dados numa tacada.
      await this.sheetsClient.clearRange(spreadsheetId, `${tabName}!A1:Z10000`);
      await this.sheetsClient.updateRange(spreadsheetId, dataRange, [
        header,
        ...rows,
      ]);
    } catch (err: any) {
      this.logger.error(
        `Falha ao sincronizar planilha de leads: ${
          err?.response?.data?.error?.message || err?.message || err
        }`,
      );
      throw err;
    }

    this.logger.log(`Leads sheet sync: ${rows.length} card(s) escrito(s).`);
    return { rows: rows.length };
  }

  /**
   * Origem do lead (site/landing page/Google Ads) — gravada por
   * `LeadOriginService` em `Contact.metadata.origin` quando a primeira
   * mensagem trazia o marcador `#origem:<slug>`. Sem marcador (maioria dos
   * contatos hoje, e todo contato antigo), fica em branco na planilha —
   * não é erro, só significa que a origem não foi rastreada nesse caso.
   */
  private originLabel(metadata: unknown): string {
    const origin = (metadata as Record<string, unknown> | null)?.origin;
    return typeof origin === 'string' ? origin : '';
  }

  private formatDate(d: Date | null): string {
    if (!d) return '';
    return new Intl.DateTimeFormat('pt-BR', {
      timeZone: 'America/Sao_Paulo',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(d);
  }

  /**
   * Escapa valores que o Sheets pode confundir com fórmula. Com
   * `valueInputOption=USER_ENTERED` (necessário pra datas virarem célula
   * de data de verdade, não texto cru), qualquer string começando com
   * `= + - @` é interpretada como início de fórmula — telefone com `+55…`
   * é o caso real que apareceu como #ERROR! num sync em produção
   * (16/08/2026). Prefixo `'` é a convenção do próprio Sheets pra forçar
   * "trate isso como texto literal", funciona igual a digitar à mão.
   */
  private sanitizeText(value: string): string {
    if (/^[=+\-@]/.test(value)) return `'${value}`;
    return value;
  }
}
