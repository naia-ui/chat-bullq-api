import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../../../database/prisma.service';
import { ChannelAdapterRegistry } from '../../channel-hub/channel-adapter.registry';
import { MediaResolverService } from './media-resolver.service';
import axios from 'axios';

export interface TranscriptionResult {
  text: string;
  language?: string;
  durationMs?: number;
  provider: 'google-gemini' | 'openai-whisper';
  transcribedAt: string;
}

/**
 * Transcreve mensagens de áudio. Provider primário: Gemini (conta Google já
 * usada em tudo desde 24/08/2026 — decisão explícita da usuária depois da
 * conta OpenAI ficar sem crédito e derrubar a transcrição automática de
 * áudio junto com o resto). Cai pro Whisper da OpenAI só se a GEMINI_API_KEY
 * não estiver configurada OU se a chamada ao Gemini falhar — mantido como
 * rede de segurança, não como primário.
 *
 * Validado ao vivo contra a API do Gemini antes de escrever este código:
 * mandei um áudio real (ogg/opus) baixado de uma conversa de produção via
 * `inlineData` no mesmo modelo `gemini-flash-lite-latest` já usado pro chat
 * — transcreveu corretamente em português.
 *
 * Custo por transcrição — cache o resultado em `message.metadata.transcription`
 * pra nunca transcrever o mesmo áudio duas vezes. Disparado automaticamente
 * em todo áudio INBOUND (ver `inbound-message.processor.ts`) e também sob
 * demanda pela UI ("Transcrever").
 */
@Injectable()
export class TranscriptionService {
  private readonly logger = new Logger(TranscriptionService.name);

  private static readonly OPENAI_API_URL =
    'https://api.openai.com/v1/audio/transcriptions';
  private static readonly OPENAI_MODEL = 'whisper-1';
  private static readonly GEMINI_API_URL =
    'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-lite-latest:generateContent';
  private static readonly GEMINI_PROMPT =
    'Transcreva literalmente o áudio a seguir, em português do Brasil. Responda APENAS com o texto transcrito, sem comentários, sem aspas, sem introdução. Se o áudio estiver em silêncio ou incompreensível, responda com uma string vazia.';
  private static readonly MAX_BYTES = 25 * 1024 * 1024; // 25MB — teto do Whisper; usado como limite geral

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly adapterRegistry: ChannelAdapterRegistry,
    private readonly mediaResolver: MediaResolverService,
  ) {}

  async transcribe(
    messageId: string,
    organizationId: string,
    opts: {
      force?: boolean;
      access?: import('../../iam/channel-access/channel-access.service').ChannelAccess;
    } = {},
  ): Promise<TranscriptionResult> {
    const access = opts.access ?? 'ALL';
    const message = await this.prisma.message.findUnique({
      where: { id: messageId },
      include: { conversation: { include: { channel: true } } },
    });
    if (!message) throw new BadRequestException('Message not found');
    if (message.conversation.organizationId !== organizationId) {
      throw new BadRequestException('Message does not belong to organization');
    }
    if (access !== 'ALL' && !access.has(message.conversation.channelId)) {
      throw new BadRequestException('Message does not belong to organization');
    }
    if (message.type !== 'AUDIO') {
      throw new BadRequestException('Message is not an audio');
    }

    const metadata = (message.metadata ?? {}) as Record<string, any>;
    if (!opts.force && metadata.transcription?.text) {
      return metadata.transcription as TranscriptionResult;
    }

    const geminiApiKey = this.config.get<string>('GEMINI_API_KEY');
    const openaiApiKey = this.config.get<string>('OPENAI_API_KEY');
    if (!geminiApiKey && !openaiApiKey) {
      throw new BadRequestException(
        'Nem GEMINI_API_KEY nem OPENAI_API_KEY configuradas no servidor',
      );
    }

    const audio = await this.downloadAudio(message);
    if (audio.buffer.byteLength > TranscriptionService.MAX_BYTES) {
      throw new BadRequestException(
        `Audio too large (${Math.round(audio.buffer.byteLength / 1024 / 1024)}MB > 25MB)`,
      );
    }

    this.logger.log(
      `Transcribing message ${messageId} (${audio.buffer.byteLength} bytes, ${audio.mimeType})`,
    );

    let result: TranscriptionResult;
    if (geminiApiKey) {
      try {
        result = await this.transcribeViaGemini(audio, geminiApiKey);
      } catch (err: any) {
        const detail =
          err?.response?.data?.error?.message || err.message || 'unknown';
        this.logger.warn(
          `Gemini transcription failed for ${messageId}: ${detail} — ${openaiApiKey ? 'trying Whisper fallback' : 'no OpenAI key to fall back to'}`,
        );
        if (!openaiApiKey) {
          throw new BadRequestException(`Transcrição falhou: ${detail}`);
        }
        result = await this.transcribeViaWhisper(audio, openaiApiKey);
      }
    } else {
      result = await this.transcribeViaWhisper(audio, openaiApiKey!);
    }

    await this.prisma.message.update({
      where: { id: messageId },
      data: {
        metadata: {
          ...metadata,
          transcription: { ...result },
        } as any,
      },
    });

    return result;
  }

  /**
   * Gemini recebe o áudio inteiro inline (`inlineData`, base64) num turno
   * de chat normal — não é um endpoint de transcrição dedicado como o
   * Whisper, é o modelo multimodal lendo áudio e respondendo com o texto.
   * Sem `duration`/`language` estruturados no retorno (o Whisper devolve
   * isso nativamente); ambos ficam `undefined` nesse provider.
   */
  private async transcribeViaGemini(
    audio: { buffer: Buffer; mimeType?: string },
    apiKey: string,
  ): Promise<TranscriptionResult> {
    const mimeType = (audio.mimeType || 'audio/ogg').split(';')[0].trim();
    const response = await axios.post(
      TranscriptionService.GEMINI_API_URL,
      {
        contents: [
          {
            role: 'user',
            parts: [
              { text: TranscriptionService.GEMINI_PROMPT },
              {
                inlineData: {
                  mimeType,
                  data: audio.buffer.toString('base64'),
                },
              },
            ],
          },
        ],
        generationConfig: { maxOutputTokens: 4096 },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-goog-api-key': apiKey,
        },
        timeout: 120_000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
      },
    );

    const parts = response.data?.candidates?.[0]?.content?.parts ?? [];
    const text = parts
      .map((p: any) => (typeof p.text === 'string' ? p.text : ''))
      .join('')
      .trim();

    return {
      text,
      provider: 'google-gemini',
      transcribedAt: new Date().toISOString(),
    };
  }

  private async transcribeViaWhisper(
    audio: { buffer: Buffer; mimeType?: string; filename: string },
    apiKey: string,
  ): Promise<TranscriptionResult> {
    const formData = new FormData();
    const blob = new Blob([audio.buffer as BlobPart], {
      type: audio.mimeType || 'audio/mpeg',
    });
    formData.append('file', blob, audio.filename);
    formData.append('model', TranscriptionService.OPENAI_MODEL);
    formData.append('response_format', 'verbose_json');
    // Portuguese bias by default — Whisper auto-detects, this just nudges.
    formData.append(
      'prompt',
      'Conversa em português do Brasil entre cliente e atendente.',
    );

    let response;
    try {
      response = await axios.post(
        TranscriptionService.OPENAI_API_URL,
        formData,
        {
          headers: { Authorization: `Bearer ${apiKey}` },
          timeout: 120_000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
        },
      );
    } catch (err: any) {
      const detail =
        err?.response?.data?.error?.message || err.message || 'unknown';
      this.logger.error(`Whisper request failed: ${detail}`);
      throw new BadRequestException(`Transcrição falhou: ${detail}`);
    }

    const data = response.data;
    return {
      text: String(data?.text || '').trim(),
      language: data?.language,
      durationMs: data?.duration
        ? Math.round(Number(data.duration) * 1000)
        : undefined,
      provider: 'openai-whisper',
      transcribedAt: new Date().toISOString(),
    };
  }

  /**
   * Resolves the audio bytes for a message, regardless of channel.
   * - Zappfy (WhatsApp): webhook only carries an encrypted .enc URL; the
   *   resolver hits /message/download to get a playable URL and caches it.
   * - Instagram: webhook already carries a playable CDN URL.
   * - WA Official: mediaId is resolved to a URL via Graph API first.
   */
  private async downloadAudio(message: {
    id: string;
    content: any;
    conversation: { organizationId: string; channel: any };
  }): Promise<{ buffer: Buffer; mimeType?: string; filename: string }> {
    const channel = message.conversation.channel;
    const content = (message.content ?? {}) as Record<string, any>;
    const mediaId: string | undefined = content.mediaId;
    let mediaUrl: string | undefined = content.mediaUrl;
    let mimeType: string | undefined = content.mimeType;

    if (!mediaUrl && !mediaId) {
      // Resolver will hit the provider (Uazapi's /message/download etc.),
      // cache the URL on content.mediaUrl, and return it. Subsequent calls
      // skip the provider roundtrip.
      const resolved = await this.mediaResolver.resolve(
        message.id,
        message.conversation.organizationId,
      );
      mediaUrl = resolved.url;
      mimeType = mimeType || resolved.mimeType;
    }

    const adapter = this.adapterRegistry.getOutbound(channel.type);

    let buffer: Buffer;
    if (mediaId && !mediaUrl) {
      buffer = await adapter.downloadMedia(channel, mediaId);
    } else {
      try {
        buffer = await adapter.downloadMedia(channel, mediaUrl!);
      } catch {
        const response = await axios.get(mediaUrl!, {
          responseType: 'arraybuffer',
          timeout: 60_000,
        });
        buffer = Buffer.from(response.data);
      }
    }

    const filename = this.filenameFor(mimeType);
    return { buffer, mimeType, filename };
  }

  private filenameFor(mimeType?: string): string {
    if (!mimeType) return 'audio.mp3';
    if (mimeType.includes('ogg')) return 'audio.ogg';
    if (mimeType.includes('mpeg') || mimeType.includes('mp3')) return 'audio.mp3';
    if (mimeType.includes('wav')) return 'audio.wav';
    if (mimeType.includes('m4a') || mimeType.includes('mp4')) return 'audio.m4a';
    if (mimeType.includes('webm')) return 'audio.webm';
    return 'audio.mp3';
  }
}
