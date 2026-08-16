import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import * as jwt from 'jsonwebtoken';

interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

/**
 * Access token OAuth2 via Service Account (JWT Bearer flow, RFC 7523) —
 * mesmo espírito sem SDK do `GmailAuthService` (que usa refresh_token de
 * usuário), mas aqui é o fluxo servidor-a-servidor: assina um JWT com a
 * chave privada da service account e troca por um access_token, sem
 * nenhum humano precisar logar/consentir.
 *
 * Escopo fixo (só o que o sync de planilha precisa):
 * https://www.googleapis.com/auth/spreadsheets — a service account não
 * enxerga nada do Google Drive/Sheets até alguém compartilhar a planilha
 * explicitamente com o e-mail dela (client_email).
 */
@Injectable()
export class GoogleSheetsAuthService {
  private readonly logger = new Logger(GoogleSheetsAuthService.name);
  private cachedToken: { accessToken: string; expiresAt: number } | null =
    null;

  constructor(private readonly config: ConfigService) {}

  private getServiceAccount(): ServiceAccountKey | null {
    const raw = this.config.get<string>('GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON');
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as ServiceAccountKey;
      if (!parsed.client_email || !parsed.private_key) return null;
      return parsed;
    } catch (err) {
      this.logger.error(
        `GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON inválido (não é JSON válido): ${(err as Error).message}`,
      );
      return null;
    }
  }

  hasCredentials(): boolean {
    return !!this.getServiceAccount();
  }

  async getAccessToken(): Promise<string> {
    if (this.cachedToken && Date.now() < this.cachedToken.expiresAt) {
      return this.cachedToken.accessToken;
    }

    const account = this.getServiceAccount();
    if (!account) {
      throw new Error(
        'GOOGLE_SHEETS_SERVICE_ACCOUNT_JSON não configurada ou inválida',
      );
    }

    const tokenUri = account.token_uri || 'https://oauth2.googleapis.com/token';
    const now = Math.floor(Date.now() / 1000);
    const assertion = jwt.sign(
      {
        iss: account.client_email,
        scope: 'https://www.googleapis.com/auth/spreadsheets',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      },
      account.private_key,
      { algorithm: 'RS256' },
    );

    const resp = await axios.post(
      tokenUri,
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000,
      },
    );

    const accessToken: string = resp.data.access_token;
    const expiresIn: number = resp.data.expires_in ?? 3600;
    this.cachedToken = {
      accessToken,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    };
    return accessToken;
  }
}
