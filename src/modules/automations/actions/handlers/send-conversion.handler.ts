import { Injectable } from '@nestjs/common';
import { ConversionsService } from '../../../conversions/conversions.service';
import {
  EVENT_NAMES,
  ConversionEventName,
} from '../../../conversions/conversions.constants';
import { CardStageChangedPayload } from '../../automations.types';
import {
  ActionContext,
  ActionExecutionResult,
  ActionHandler,
} from '../action.types';

interface SendConversionParams {
  /**
   * Nome do evento. Na ausência, deriva da etapa: tipo WON vira "Contrato",
   * etapa de consulta vira "Schedule", o resto "Lead". Deixar em branco é o
   * normal — só se preenche para forçar.
   */
  eventName?: ConversionEventName;
}

/**
 * Ação "devolver conversão à plataforma de anúncio".
 *
 * Só funciona no gatilho CARD_STAGE_CHANGED: é o movimento do card, feito
 * por uma pessoa, que autoriza o envio. A ação em si **não chama** Meta nem
 * Google — ela põe na fila. Quem envia é o despachante, depois da carência
 * e com as chaves ligadas.
 *
 * Sem origem de anúncio (nem código, nem clique), o lead é ignorado com
 * motivo no log do run — não é falha, é lead orgânico.
 */
@Injectable()
export class SendConversionHandler implements ActionHandler {
  readonly type = 'send_conversion' as const;
  // Enfileirar é passo externo e não deixa estado pela metade: um erro aqui
  // não deve impedir as outras ações da mesma regra (tag, atribuição).
  readonly continueOnErrorDefault = true;

  constructor(private readonly conversions: ConversionsService) {}

  validateParams(params: Record<string, unknown>): void {
    if (params.eventName === undefined) return;
    if (
      typeof params.eventName !== 'string' ||
      !(EVENT_NAMES as readonly string[]).includes(params.eventName)
    ) {
      throw new Error(
        `send_conversion: "eventName" deve ser ${EVENT_NAMES.join(' | ')}`,
      );
    }
  }

  async execute(
    params: Record<string, unknown>,
    ctx: ActionContext,
  ): Promise<ActionExecutionResult> {
    const p = params as unknown as SendConversionParams;
    const payload = ctx.payload as CardStageChangedPayload;

    if (!payload.cardId) {
      return {
        ok: false,
        errorCode: 'invalid_params',
        errorMessage:
          'send_conversion só vale no gatilho "card mudou de etapa" (sem cardId no evento)',
      };
    }

    try {
      const result = await this.conversions.enqueueForCardStage({
        organizationId: ctx.organizationId,
        cardId: payload.cardId,
        eventName: p.eventName,
      });

      if (result.queued.length === 0) {
        // Lead sem origem de mídia paga: nada a devolver. Fica registrado
        // no run para a conferência semanal.
        return {
          ok: true,
          output: {
            enfileiradas: 0,
            motivo: result.skipped ?? 'nada a enfileirar',
            evento: result.eventName,
          },
        };
      }

      return {
        ok: true,
        output: {
          enfileiradas: result.queued.length,
          plataformas: result.queued.map(
            (q) => `${q.platform}:${q.matchKind}`,
          ),
          evento: result.eventName,
        },
      };
    } catch (err) {
      return {
        ok: false,
        errorCode: 'unexpected',
        errorMessage: (err as Error).message,
      };
    }
  }
}
