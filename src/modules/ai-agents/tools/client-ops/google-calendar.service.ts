import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';
import { randomUUID } from 'crypto';
import { GoogleAuthService } from './google-auth.service';
import { SOFIA_TIMEZONE } from './client-ops.constants';

export interface CreatedCalendarEvent {
  eventId: string;
  htmlLink: string | null;
  meetLink: string | null;
}

/**
 * Criação de eventos no Google Calendar com Meet, na agenda configurada
 * (default produtos@asv.digital — padrão das reuniões de implementação).
 * Convites saem com sendUpdates=all, então os participantes recebem email.
 */
@Injectable()
export class GoogleCalendarService {
  private readonly logger = new Logger(GoogleCalendarService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly auth: GoogleAuthService,
  ) {}

  private get calendarId(): string {
    return (
      this.config.get<string>('SOFIA_CALENDAR_ID') ?? 'produtos@asv.digital'
    );
  }

  async createEventWithMeet(input: {
    summary: string;
    description?: string;
    startIso: string;
    endIso: string;
    attendeeEmails: string[];
  }): Promise<CreatedCalendarEvent> {
    const token = await this.auth.getCalendarToken();
    const resp = await axios.post(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(this.calendarId)}/events?conferenceDataVersion=1&sendUpdates=all`,
      {
        summary: input.summary,
        description: input.description,
        start: { dateTime: input.startIso, timeZone: SOFIA_TIMEZONE },
        end: { dateTime: input.endIso, timeZone: SOFIA_TIMEZONE },
        attendees: input.attendeeEmails.map((email) => ({ email })),
        conferenceData: {
          createRequest: {
            requestId: randomUUID(),
            conferenceSolutionKey: { type: 'hangoutsMeet' },
          },
        },
      },
      {
        headers: { Authorization: `Bearer ${token}` },
        timeout: 15_000,
      },
    );

    const ev = resp.data;
    const meetLink: string | null =
      ev.hangoutLink ??
      ev.conferenceData?.entryPoints?.find(
        (e: { entryPointType: string }) => e.entryPointType === 'video',
      )?.uri ??
      null;

    this.logger.log(
      `Evento criado ${ev.id} em ${this.calendarId} (${input.startIso})`,
    );
    return { eventId: ev.id, htmlLink: ev.htmlLink ?? null, meetLink };
  }
}
