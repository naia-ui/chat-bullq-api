import { isMetaDefaultAdMessage, parseAdRef } from './ad-ref-gate';

describe('parseAdRef', () => {
  it.each([
    ['Olá! Vi o vídeo sobre sindicância no CRM e gostaria de orientação. (ref. DMV)', 'dmv', 'DM'],
    ['Olá! Recebi uma notificação do CRM e gostaria de orientação. (ref. DM01)', 'dm01', 'DM'],
    ['Olá! Tenho dúvidas sobre prontuário e defesa no CRM. (ref. DM02)', 'dm02', 'DM'],
    ['Olá! Vi o anúncio da Dra. Naiá sobre defesa de médicos e gostaria de orientação. (ref. DM04)', 'dm04', 'DM'],
    ['Vi o anúncio sobre férias (ref. TR01)', 'tr01', 'TR'],
    ['texto editado (REF.ag02)', 'ag02', 'AG'],
  ])('lê o código em "%s"', (text, code, prefix) => {
    expect(parseAdRef(text)).toEqual({ code, prefix });
  });

  it.each([
    'Olá, quero orientação',
    'minha referência é 123',
    '(ref. 12)',
    '',
    null,
  ])('ignora "%s"', (text) => {
    expect(parseAdRef(text as string | null)).toBeNull();
  });
});

describe('isMetaDefaultAdMessage', () => {
  it('reconhece a frase padrão da Meta', () => {
    expect(
      isMetaDefaultAdMessage('Olá! Gostaria de mais informações sobre isso.'),
    ).toBe(true);
  });
  it('ignora mensagem comum', () => {
    expect(isMetaDefaultAdMessage('Bom dia')).toBe(false);
  });
});
