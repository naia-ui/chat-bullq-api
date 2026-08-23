import { Injectable } from '@nestjs/common';
import type { Organization } from '@prisma/client';
import {
  DEFAULT_WATCHDOG_CONFIG,
  WatchdogConfig,
} from './watchdog.types';
import { isWithinBusinessHours } from '../../ai-agents/router/business-hours.util';

/**
 * Resolve a config efetiva do watchdog (merge defaults + override do banco)
 * e expõe `isWithinBusinessHours()` — delega pro util compartilhado
 * (`business-hours.util.ts`) em vez de reimplementar a lógica; era duas
 * cópias quase idênticas (essa + `AgentRouterService`) que divergiram e
 * causaram um bug real em produção.
 */
@Injectable()
export class WatchdogConfigService {
  resolve(org: Pick<Organization, 'watchdogConfig'>): Required<WatchdogConfig> {
    const override = (org.watchdogConfig as WatchdogConfig | null) ?? {};
    return {
      delayBotMin: override.delayBotMin ?? DEFAULT_WATCHDOG_CONFIG.delayBotMin,
      delayPendingMin:
        override.delayPendingMin ?? DEFAULT_WATCHDOG_CONFIG.delayPendingMin,
      delayHumanIdleMin:
        override.delayHumanIdleMin ?? DEFAULT_WATCHDOG_CONFIG.delayHumanIdleMin,
      maxAttempts:
        override.maxAttempts ?? DEFAULT_WATCHDOG_CONFIG.maxAttempts,
    };
  }

  isWithinBusinessHours(
    org: Pick<Organization, 'watchdogBusinessHours' | 'aiTimezone'>,
  ): boolean {
    return isWithinBusinessHours(org.watchdogBusinessHours, org.aiTimezone);
  }
}
