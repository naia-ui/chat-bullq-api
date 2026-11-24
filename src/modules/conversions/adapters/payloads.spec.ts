import { ConfigService } from '@nestjs/config';
import { ConversionsConfigService } from '../conversions.config';
import { hashPhone } from '../origin';
import { MetaCapiAdapter } from './meta-capi.adapter';
import { formatGoogleDateTime, GoogleAdsAdapter } from './google-ads.adapter';

function configWith(env: Record<string, string>): ConversionsConfigService {
  const fake = {
    get: (key: string) => env[key],
  } as unknown as ConfigService;
  return new ConversionsConfigService(fake);
}

const occurredAt = new Date('2026-11-20T15:30:00.000Z');

describe('corpo do envio à Meta', () => {
  it('telefone sai só como hash, em array', () => {
    const adapter = new MetaCapiAdapter(configWith({}));
    const hash = hashPhone('54991962299') as string;
    const payload = adapter.buildPayload({
      eventId: 'conv_1',
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'phone_hash',
      matchValue: hash,
    }) as any;

    expect(payload.data[0].user_data).toEqual({ ph: [hash] });
    // O número não aparece em nenhuma forma no corpo do envio.
    const corpo = JSON.stringify(payload);
    expect(corpo).not.toContain('54991962299');
    expect(corpo).not.toContain('5554991962299');
  });

  it('event_id é a linha da fila — é o que faz a Meta deduplicar', () => {
    const adapter = new MetaCapiAdapter(configWith({}));
    const payload = adapter.buildPayload({
      eventId: 'conv_abc',
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'phone_hash',
      matchValue: 'x'.repeat(64),
    }) as any;
    expect(payload.data[0].event_id).toBe('conv_abc');
    expect(payload.data[0].event_time).toBe(
      Math.floor(occurredAt.getTime() / 1000),
    );
  });

  it('ctwa_clid vai cru, sem telefone', () => {
    const adapter = new MetaCapiAdapter(configWith({}));
    const payload = adapter.buildPayload({
      eventId: 'conv_2',
      eventName: 'Lead',
      occurredAt,
      matchKind: 'ctwa_clid',
      matchValue: 'ctwa_123456789',
    }) as any;
    expect(payload.data[0].user_data).toEqual({ ctwa_clid: 'ctwa_123456789' });
  });

  it('fbclid é montado no formato fbc da Meta', () => {
    const adapter = new MetaCapiAdapter(configWith({}));
    const payload = adapter.buildPayload({
      eventId: 'conv_3',
      eventName: 'Lead',
      occurredAt,
      matchKind: 'fbclid',
      matchValue: 'IwAR_abc123456',
    }) as any;
    expect(payload.data[0].user_data.fbc).toBe(
      `fb.1.${Math.floor(occurredAt.getTime() / 1000)}.IwAR_abc123456`,
    );
  });

  it('sem valor configurado, o evento vai sem valor', () => {
    const adapter = new MetaCapiAdapter(configWith({}));
    const payload = adapter.buildPayload({
      eventId: 'conv_4',
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'phone_hash',
      matchValue: 'y'.repeat(64),
      value: null,
    }) as any;
    expect(payload.data[0].custom_data).toBeUndefined();
  });

  it('código de teste entra no corpo quando configurado', () => {
    const adapter = new MetaCapiAdapter(
      configWith({ CAPI_TEST_EVENT_CODE: 'TEST123' }),
    );
    const payload = adapter.buildPayload({
      eventId: 'conv_5',
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'phone_hash',
      matchValue: 'z'.repeat(64),
    }) as any;
    expect(payload.test_event_code).toBe('TEST123');
  });

  it('o token nunca aparece no corpo montado', () => {
    const adapter = new MetaCapiAdapter(
      configWith({ CAPI_TOKEN: 'segredo-do-sistema', CAPI_PIXEL_ID: '1477409167548952' }),
    );
    const payload = adapter.buildPayload({
      eventId: 'conv_6',
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'phone_hash',
      matchValue: 'w'.repeat(64),
    });
    expect(JSON.stringify(payload)).not.toContain('segredo-do-sistema');
  });
});

describe('corpo do envio ao Google', () => {
  it('manda o gclid e a ação configurada', () => {
    const adapter = new GoogleAdsAdapter(
      configWith({
        GOOGLE_ADS_ACTION_CONTRACT: 'customers/9840316850/conversionActions/123',
      }),
    );
    const payload = adapter.buildPayload({
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'gclid',
      matchValue: 'Cj0KCQiA_abc-123',
    }) as any;

    expect(payload.conversions[0].gclid).toBe('Cj0KCQiA_abc-123');
    expect(payload.conversions[0].conversionAction).toBe(
      'customers/9840316850/conversionActions/123',
    );
    expect(payload.validateOnly).toBe(false);
  });

  it('validateOnly confere sem gravar', () => {
    const adapter = new GoogleAdsAdapter(configWith({}));
    const payload = adapter.buildPayload({
      eventName: 'Contrato',
      occurredAt,
      matchKind: 'gclid',
      matchValue: 'Cj0KCQiA_abc-123',
      validateOnly: true,
    }) as any;
    expect(payload.validateOnly).toBe(true);
  });

  it('gbraid e wbraid vão no campo próprio', () => {
    const adapter = new GoogleAdsAdapter(configWith({}));
    const g = adapter.buildPayload({
      eventName: 'Lead',
      occurredAt,
      matchKind: 'gbraid',
      matchValue: 'abcdefghij1',
    }) as any;
    expect(g.conversions[0].gbraid).toBe('abcdefghij1');
    expect(g.conversions[0].gclid).toBeUndefined();
  });

  it('a data leva o fuso explícito, como o Google exige', () => {
    expect(formatGoogleDateTime(new Date('2026-11-20T15:30:00.000Z'))).toBe(
      '2026-11-20 12:30:00-03:00',
    );
  });
});

describe('chaves desligadas de fábrica', () => {
  it('sem variável nenhuma, nada está ligado', () => {
    const config = configWith({});
    expect(config.enabled).toBe(false);
    expect(config.dryRun).toBe(true);
    expect(config.sendRealValue).toBe(false);
    expect(config.meta.enabled).toBe(false);
    expect(config.google.enabled).toBe(false);
    expect(config.graceHours).toBe(24);
  });

  it('ligar a chave sem credencial não liga a plataforma', () => {
    const config = configWith({
      CONVERSIONS_ENABLED: 'true',
      META_CAPI_ENABLED: 'true',
    });
    expect(config.meta.enabled).toBe(false);
    expect(config.platformOffReason('META')).toMatch(/CAPI_PIXEL_ID ausente/);
  });

  it('com as duas chaves e credencial, a Meta fica ligada', () => {
    const config = configWith({
      CONVERSIONS_ENABLED: 'true',
      META_CAPI_ENABLED: 'true',
      CAPI_PIXEL_ID: '1477409167548952',
      CAPI_TOKEN: 'token',
    });
    expect(config.meta.enabled).toBe(true);
    expect(config.platformOffReason('META')).toBeNull();
  });
});
