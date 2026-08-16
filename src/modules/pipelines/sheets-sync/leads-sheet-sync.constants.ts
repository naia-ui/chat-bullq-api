export const LEADS_SHEET_SYNC_QUEUE = 'leads-sheet-sync';
export const LEADS_SHEET_SYNC_JOB = 'leads-sheet-sync-tick';

/** Intervalo do sync — sobreponível via env LEADS_SHEET_SYNC_PATTERN. */
export const LEADS_SHEET_SYNC_PATTERN_DEFAULT = '*/15 * * * *'; // a cada 15 min

/**
 * Nome da aba (tab) dentro da planilha onde os dados são escritos —
 * sobreponível via env GOOGLE_SHEETS_TAB_NAME. O cron CRIA essa aba
 * sozinho se ela não existir (GoogleSheetsClientService.ensureSheetExists)
 * — nunca escreve em cima de aba já existente com outro propósito. Nome
 * default deliberadamente específico pra nunca colidir com abas
 * manuais já usadas na planilha (ex.: "CRM", "TRAB", meses do ano).
 */
export const LEADS_SHEET_TAB_NAME_DEFAULT = 'Leads (Justine OS)';
