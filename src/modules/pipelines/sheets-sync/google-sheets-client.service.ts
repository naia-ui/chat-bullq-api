import { Injectable } from '@nestjs/common';
import axios from 'axios';
import { GoogleSheetsAuthService } from './google-sheets-auth.service';

@Injectable()
export class GoogleSheetsClientService {
  private static readonly BASE_URL =
    'https://sheets.googleapis.com/v4/spreadsheets';

  constructor(private readonly auth: GoogleSheetsAuthService) {}

  /**
   * Garante que a aba existe ANTES de qualquer clear/write — cria só se
   * não existir. Nunca toca em aba já existente (não renomeia, não
   * reordena, não altera propriedades de nenhuma aba que já estava lá).
   * Idempotente: chamar de novo com a aba já criada é no-op.
   */
  async ensureSheetExists(
    spreadsheetId: string,
    tabName: string,
  ): Promise<void> {
    const token = await this.auth.getAccessToken();
    const meta = await axios.get(
      `${GoogleSheetsClientService.BASE_URL}/${spreadsheetId}`,
      {
        params: { fields: 'sheets.properties.title' },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      },
    );
    const titles: string[] = (meta.data.sheets ?? []).map(
      (s: any) => s.properties.title,
    );
    if (titles.includes(tabName)) return;

    await axios.post(
      `${GoogleSheetsClientService.BASE_URL}/${spreadsheetId}:batchUpdate`,
      { requests: [{ addSheet: { properties: { title: tabName } } }] },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      },
    );
  }

  /**
   * Sobrescreve um range com uma matriz de valores (linha 0 do array =
   * primeira linha do range, normalmente o header). `USER_ENTERED` deixa
   * o Sheets interpretar o valor como se fosse digitado à mão (datas,
   * números formatados), em vez de forçar tudo como texto cru.
   */
  async updateRange(
    spreadsheetId: string,
    range: string,
    values: Array<Array<string | number>>,
  ): Promise<void> {
    const token = await this.auth.getAccessToken();
    await axios.put(
      `${GoogleSheetsClientService.BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}`,
      { range, majorDimension: 'ROWS', values },
      {
        params: { valueInputOption: 'USER_ENTERED' },
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20_000,
      },
    );
  }

  /**
   * Limpa um range inteiro antes de reescrever — evita sobrar linha velha
   * na planilha quando a contagem de leads diminui de um sync pro outro.
   */
  async clearRange(spreadsheetId: string, range: string): Promise<void> {
    const token = await this.auth.getAccessToken();
    await axios.post(
      `${GoogleSheetsClientService.BASE_URL}/${spreadsheetId}/values/${encodeURIComponent(range)}:clear`,
      {},
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 20_000,
      },
    );
  }
}
