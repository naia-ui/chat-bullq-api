import { Injectable } from '@nestjs/common';
import { IntentType } from './intent.types';

/**
 * Mapeia um intent classificado pro nome do agente que deve atender e diz
 * se o fallback (orquestrador, ou qualquer agente ativo do canal na
 * ausência de um) pode ser pulado.
 *
 * Decisão de "skip" é binária aqui — o threshold de confidence é aplicado
 * pelo IntentClassifierService antes de gerar o ClassificationResult final.
 * Esse service é puro lookup.
 *
 * `agentName` só importa de verdade quando `skip: true` (o AgentRouterService
 * busca um agente ativo com esse nome exato pra pular direto pro worker).
 * Nos demais casos o fallback resolve pra qualquer agente AUTONOMOUS ativo
 * do canal, então o nome aqui é só documentação.
 */
@Injectable()
export class IntentRouterService {
  private static readonly MAP: Record<
    IntentType,
    { agentName: string; skip: boolean }
  > = {
    [IntentType.LEGAL_MATTER]: { agentName: 'Justine Trabalhista', skip: true },
    [IntentType.SMALL_TALK]: { agentName: 'Justine Trabalhista', skip: false },
    [IntentType.AMBIGUOUS]: { agentName: 'Justine Trabalhista', skip: false },
    [IntentType.SPAM_OR_NOISE]: { agentName: 'Justine Trabalhista', skip: false },
    [IntentType.ESCALATE_HUMAN]: { agentName: 'Justine Trabalhista', skip: false },
  };

  routeIntent(intent: IntentType): {
    agentName: string;
    shouldSkipOrchestrator: boolean;
  } {
    const r = IntentRouterService.MAP[intent];
    return {
      agentName: r.agentName,
      shouldSkipOrchestrator: r.skip,
    };
  }
}
