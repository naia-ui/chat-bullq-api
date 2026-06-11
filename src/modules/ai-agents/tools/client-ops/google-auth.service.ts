import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { createSign } from 'crypto';

interface CachedToken {
  accessToken: string;
  expiresAt: number;
}

/**
 * Tokens de acesso Google sem SDK externo:
 *
 * - Calendar: OAuth de usuário (produtos@asv.digital) via refresh_token —
 *   permite criar evento com Meet e CONVIDADOS, coisa que service account
 *   sem domain-wide delegation não consegue.
 * - Drive: service account (read-only) — enxerga as pastas compartilhadas
 *   com ela (Meet Recordings + 00. Projetos Implementação).
 *
 * Env required:
 * - GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET / GOOGLE_OAUTH_REFRESH_TOKEN
 * - GOOGLE_SA_JSON_B64 (JSON da service account em base64)
 */
@Injectable()
export class GoogleAuthService {
  private readonly logger = new Logger(GoogleAuthService.name);
  private readonly cache = new Map<string, CachedToken>();

  constructor(private readonly config: ConfigService) {}

  hasOAuth(): boolean {
    return !!(
      this.config.get('GOOGLE_OAUTH_CLIENT_ID') &&
      this.config.get('GOOGLE_OAUTH_CLIENT_SECRET') &&
      this.config.get('GOOGLE_OAUTH_REFRESH_TOKEN')
    );
  }

  hasServiceAccount(): boolean {
    return !!this.config.get('GOOGLE_SA_JSON_B64');
  }

  /** Token OAuth do usuário (scope calendar). */
  async getCalendarToken(): Promise<string> {
    const cached = this.cache.get('oauth');
    if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

    const resp = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        client_id: this.config.get<string>('GOOGLE_OAUTH_CLIENT_ID') ?? '',
        client_secret:
          this.config.get<string>('GOOGLE_OAUTH_CLIENT_SECRET') ?? '',
        refresh_token:
          this.config.get<string>('GOOGLE_OAUTH_REFRESH_TOKEN') ?? '',
        grant_type: 'refresh_token',
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000,
      },
    );
    const token: string = resp.data.access_token;
    const expiresIn: number = resp.data.expires_in ?? 3600;
    this.cache.set('oauth', {
      accessToken: token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    });
    return token;
  }

  /** Token da service account (scope drive.readonly). */
  async getDriveToken(): Promise<string> {
    const cached = this.cache.get('sa');
    if (cached && Date.now() < cached.expiresAt) return cached.accessToken;

    const b64 = this.config.get<string>('GOOGLE_SA_JSON_B64');
    if (!b64) throw new Error('GOOGLE_SA_JSON_B64 não configurada');
    const sa = JSON.parse(Buffer.from(b64, 'base64').toString('utf8')) as {
      client_email: string;
      private_key: string;
    };

    const now = Math.floor(Date.now() / 1000);
    const b64url = (data: Buffer | string): string =>
      Buffer.from(data).toString('base64url');
    const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/drive.readonly',
        aud: 'https://oauth2.googleapis.com/token',
        iat: now,
        exp: now + 3600,
      }),
    );
    const signer = createSign('RSA-SHA256');
    signer.update(`${header}.${claims}`);
    const signature = signer.sign(sa.private_key).toString('base64url');
    const jwt = `${header}.${claims}.${signature}`;

    const resp = await axios.post(
      'https://oauth2.googleapis.com/token',
      new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion: jwt,
      }).toString(),
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10_000,
      },
    );
    const token: string = resp.data.access_token;
    const expiresIn: number = resp.data.expires_in ?? 3600;
    this.cache.set('sa', {
      accessToken: token,
      expiresAt: Date.now() + (expiresIn - 60) * 1000,
    });
    return token;
  }
}
