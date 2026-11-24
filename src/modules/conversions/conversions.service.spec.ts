import { ConfigService } from '@nestjs/config';
import { ConversionPlatform, ConversionStatus } from '@prisma/client';
import { ConversionsConfigService } from './conversions.config';
import { ConversionsService, eventNameForStage } from './conversions.service';
import { GoogleAdsAdapter } from './adapters/google-ads.adapter';
import { MetaCapiAdapter } from './adapters/meta-capi.adapter';

/**
 * Testes sem banco e sem rede. O que está sendo garantido aqui é o que a
 * titular precisa poder afirmar: nada sai antes da carência, nada sai duas
 * vezes, nada sai fora da janela e nada sai com as chaves desligadas.
 */

function makeConfig(env: Record<string, string> = {}) {
  return new ConversionsConfigService({
    get: (key: string) => env[key],
  } as unknown as ConfigService);
}

function makePrisma() {
  return {
    card: { findFirst: jest.fn() },
    conversionEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findMany: jest.fn().mockResolvedValue([]),
      groupBy: jest.fn().mockResolvedValue([]),
    },
  } as any;
}

function makeService(env: Record<string, string> = {}) {
  const prisma = makePrisma();
  const config = makeConfig(env);
  const meta = new MetaCapiAdapter(config);
  const google = new GoogleAdsAdapter(config);
  jest.spyOn(meta, 'send');
  jest.spyOn(google, 'send');
  const service = new ConversionsService(prisma, config, meta, google);
  return { service, prisma, config, meta, google };
}

const cardBase = {
  id: 'card_1',
  organizationId: 'org_1',
  stageId: 'stage_won',
  currency: 'BRL',
  value: 3500,
  closedAt: new Date('2026-11-20T12:00:00.000Z'),
  metadata: {},
  stage: { id: 'stage_won', key: 'won', name: 'Contrato assinado', type: 'WON' },
  contact: { id: 'contact_1', phone: '54991962299', metadata: { origin: 'dm01' } },
};

describe('entrada na fila', () => {
  it('enfileira a Meta para lead de campanha, em simulação e com carência', async () => {
    const { service, prisma } = makeService();
    prisma.card.findFirst.mockResolvedValue(cardBase);

    const result = await service.enqueueForCardStage({
      organizationId: 'org_1',
      cardId: 'card_1',
    });

    expect(result.queued).toEqual([
      { platform: ConversionPlatform.META, matchKind: 'phone_hash' },
    ]);
    expect(result.eventName).toBe('Contrato');

    const data = prisma.conversionEvent.create.mock.calls[0][0].data;
    expect(data.status).toBe(ConversionStatus.PENDING);
    expect(data.dryRun).toBe(true);
    expect(data.eventName).toBe('Contrato');
    expect(data.matchValue).toHaveLength(64);
    // Carência de 24 h a partir do fato.
    expect(data.releaseAt.getTime() - data.occurredAt.getTime()).toBe(
      24 * 3_600_000,
    );
    // Valor real não vai sem a chave própria.
    expect(data.value).toBeNull();
  });

  it('envia o valor do contrato só com CONVERSIONS_SEND_REAL_VALUE', async () => {
    const { service, prisma } = makeService({
      CONVERSIONS_SEND_REAL_VALUE: 'true',
    });
    prisma.card.findFirst.mockResolvedValue(cardBase);
    await service.enqueueForCardStage({ organizationId: 'org_1', cardId: 'card_1' });
    expect(prisma.conversionEvent.create.mock.calls[0][0].data.value).toBe(3500);
  });

  it('conversão já enviada não é enfileirada de novo', async () => {
    const { service, prisma } = makeService();
    prisma.card.findFirst.mockResolvedValue(cardBase);
    prisma.conversionEvent.findUnique.mockResolvedValue({
      id: 'conv_1',
      status: ConversionStatus.SENT,
    });

    const result = await service.enqueueForCardStage({
      organizationId: 'org_1',
      cardId: 'card_1',
    });

    expect(result.queued).toHaveLength(0);
    expect(prisma.conversionEvent.create).not.toHaveBeenCalled();
    expect(prisma.conversionEvent.update).not.toHaveBeenCalled();
  });

  it('conversão pendente não é duplicada nem reprogramada', async () => {
    const { service, prisma } = makeService();
    prisma.card.findFirst.mockResolvedValue(cardBase);
    prisma.conversionEvent.findUnique.mockResolvedValue({
      id: 'conv_1',
      status: ConversionStatus.PENDING,
    });
    await service.enqueueForCardStage({ organizationId: 'org_1', cardId: 'card_1' });
    expect(prisma.conversionEvent.create).not.toHaveBeenCalled();
    expect(prisma.conversionEvent.update).not.toHaveBeenCalled();
  });

  it('recusada volta à fila quando a etapa é marcada de novo', async () => {
    const { service, prisma } = makeService();
    prisma.card.findFirst.mockResolvedValue(cardBase);
    prisma.conversionEvent.findUnique.mockResolvedValue({
      id: 'conv_1',
      status: ConversionStatus.FAILED,
    });

    await service.enqueueForCardStage({ organizationId: 'org_1', cardId: 'card_1' });

    expect(prisma.conversionEvent.create).not.toHaveBeenCalled();
    const update = prisma.conversionEvent.update.mock.calls[0][0];
    expect(update.where).toEqual({ id: 'conv_1' });
    expect(update.data.status).toBe(ConversionStatus.PENDING);
    expect(update.data.lastError).toBeNull();
  });

  it('lead sem origem de anúncio não gera envio, e diz o motivo', async () => {
    const { service, prisma } = makeService();
    prisma.card.findFirst.mockResolvedValue({
      ...cardBase,
      contact: { id: 'contact_2', phone: '54991962299', metadata: {} },
    });

    const result = await service.enqueueForCardStage({
      organizationId: 'org_1',
      cardId: 'card_1',
    });

    expect(result.queued).toHaveLength(0);
    expect(result.skipped).toMatch(/sem origem registrada/);
    expect(prisma.conversionEvent.create).not.toHaveBeenCalled();
  });

  it('mover o card cancela o que estava pendente em outra etapa', async () => {
    const { service, prisma } = makeService();
    await service.cancelPendingOnMove(prisma, 'card_1', 'stage_proposta');

    const call = prisma.conversionEvent.updateMany.mock.calls[0][0];
    expect(call.where).toEqual({
      cardId: 'card_1',
      stageId: { not: 'stage_proposta' },
      status: ConversionStatus.PENDING,
    });
    expect(call.data.status).toBe(ConversionStatus.CANCELLED);
  });
});

describe('despachante', () => {
  it('só olha o que já venceu a carência', async () => {
    const { service, prisma } = makeService();
    await service.dispatchDue();
    const where = prisma.conversionEvent.findMany.mock.calls[0][0].where;
    expect(where.status).toBe(ConversionStatus.PENDING);
    expect(where.releaseAt.lte).toBeInstanceOf(Date);
  });

  const dueRow = {
    id: 'conv_1',
    platform: ConversionPlatform.META,
    eventName: 'Contrato',
    occurredAt: new Date(Date.now() - 2 * 86_400_000),
    matchKind: 'phone_hash',
    matchValue: 'a'.repeat(64),
    value: null,
    currency: 'BRL',
    attemptCount: 0,
  };

  it('descarta evento fora da janela da plataforma, sem remendar a data', async () => {
    const { service, prisma, meta } = makeService({
      CONVERSIONS_ENABLED: 'true',
      CONVERSIONS_DRY_RUN: 'false',
      META_CAPI_ENABLED: 'true',
      CAPI_PIXEL_ID: '1477409167548952',
      CAPI_TOKEN: 'token',
    });
    prisma.conversionEvent.findMany.mockResolvedValue([
      { ...dueRow, occurredAt: new Date(Date.now() - 10 * 86_400_000) },
    ]);

    const tally = await service.dispatchDue();

    expect(tally.skipped).toBe(1);
    expect(meta.send).not.toHaveBeenCalled();
    const data = prisma.conversionEvent.update.mock.calls[0][0].data;
    expect(data.status).toBe(ConversionStatus.SKIPPED);
    expect(data.lastError).toMatch(/fora da janela de 7 dias/);
  });

  it('com as chaves desligadas, grava a pré-visualização e não envia nada', async () => {
    const { service, prisma, meta } = makeService();
    prisma.conversionEvent.findMany.mockResolvedValue([dueRow]);

    const tally = await service.dispatchDue();

    expect(tally.previewed).toBe(1);
    expect(tally.sent).toBe(0);
    expect(meta.send).not.toHaveBeenCalled();
    const data = prisma.conversionEvent.update.mock.calls[0][0].data;
    // Continua PENDENTE: quando a chave virar, a fila drena sozinha.
    expect(data.status).toBeUndefined();
    expect(data.dryRun).toBe(true);
    expect(data.response.preview.data[0].event_name).toBe('Contrato');
    expect(data.lastError).toMatch(/CONVERSIONS_ENABLED desligado/);
  });

  it('em simulação com tudo configurado, ainda não envia', async () => {
    const { service, prisma, meta } = makeService({
      CONVERSIONS_ENABLED: 'true',
      CONVERSIONS_DRY_RUN: 'true',
      META_CAPI_ENABLED: 'true',
      CAPI_PIXEL_ID: '1477409167548952',
      CAPI_TOKEN: 'token',
    });
    prisma.conversionEvent.findMany.mockResolvedValue([dueRow]);

    const tally = await service.dispatchDue();

    expect(tally.previewed).toBe(1);
    expect(meta.send).not.toHaveBeenCalled();
    expect(prisma.conversionEvent.update.mock.calls[0][0].data.lastError).toMatch(
      /DRY_RUN/,
    );
  });

  it('com tudo ligado, envia e marca como enviada', async () => {
    const { service, prisma, meta } = makeService({
      CONVERSIONS_ENABLED: 'true',
      CONVERSIONS_DRY_RUN: 'false',
      META_CAPI_ENABLED: 'true',
      CAPI_PIXEL_ID: '1477409167548952',
      CAPI_TOKEN: 'token',
    });
    prisma.conversionEvent.findMany.mockResolvedValue([dueRow]);
    (meta.send as jest.Mock).mockResolvedValue({
      ok: true,
      request: {},
      response: { events_received: 1 },
    });

    const tally = await service.dispatchDue();

    expect(tally.sent).toBe(1);
    expect(meta.send).toHaveBeenCalledTimes(1);
    const data = prisma.conversionEvent.update.mock.calls[0][0].data;
    expect(data.status).toBe(ConversionStatus.SENT);
    expect(data.sentAt).toBeInstanceOf(Date);
    expect(data.dryRun).toBe(false);
  });

  it('erro transitório mantém a linha na fila; recusa definitiva marca falha', async () => {
    const env = {
      CONVERSIONS_ENABLED: 'true',
      CONVERSIONS_DRY_RUN: 'false',
      META_CAPI_ENABLED: 'true',
      CAPI_PIXEL_ID: '1477409167548952',
      CAPI_TOKEN: 'token',
    };

    const transitorio = makeService(env);
    transitorio.prisma.conversionEvent.findMany.mockResolvedValue([dueRow]);
    (transitorio.meta.send as jest.Mock).mockResolvedValue({
      ok: false,
      request: {},
      errorMessage: '500: oops',
      retryable: true,
    });
    await transitorio.service.dispatchDue();
    expect(
      transitorio.prisma.conversionEvent.update.mock.calls[0][0].data.status,
    ).toBe(ConversionStatus.PENDING);

    const definitivo = makeService(env);
    definitivo.prisma.conversionEvent.findMany.mockResolvedValue([dueRow]);
    (definitivo.meta.send as jest.Mock).mockResolvedValue({
      ok: false,
      request: {},
      errorMessage: '400: identificador inválido',
      retryable: false,
    });
    const tally = await definitivo.service.dispatchDue();
    expect(tally.failed).toBe(1);
    expect(
      definitivo.prisma.conversionEvent.update.mock.calls[0][0].data.status,
    ).toBe(ConversionStatus.FAILED);
  });
});

describe('nome do evento pela etapa', () => {
  it('etapa de ganho vira Contrato', () => {
    expect(
      eventNameForStage({ key: 'won', name: 'Contrato assinado', type: 'WON' as any }),
    ).toBe('Contrato');
  });

  it('etapa de consulta vira Schedule', () => {
    expect(
      eventNameForStage({
        key: null,
        name: 'Consulta agendada',
        type: 'NORMAL' as any,
      }),
    ).toBe('Schedule');
  });

  it('qualquer outra etapa vira Lead', () => {
    expect(
      eventNameForStage({ key: null, name: 'Em triagem', type: 'NORMAL' as any }),
    ).toBe('Lead');
  });

  it('o nome do evento nunca carrega a área do Direito', () => {
    const nome = eventNameForStage({
      key: 'won',
      name: 'Contrato assinado — Direito Médico',
      type: 'WON' as any,
    });
    expect(nome).toBe('Contrato');
    expect(nome).not.toMatch(/dico/i);
  });
});
