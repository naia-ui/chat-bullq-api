import { WhatsAppOfficialMessageMapper } from './whatsapp-official.message-mapper';

const mapper = new WhatsAppOfficialMessageMapper();

/**
 * Payloads reduzidos a partir dos webhooks reais da Cloud API que estavam
 * caindo no fallback (`[button]`, `[contacts]`, `[Interactive message]`).
 */
const parse = (message: Record<string, any>) =>
  mapper.normalizeInbound(
    {
      id: 'wamid.TESTE',
      from: '5511999999999',
      timestamp: '1784638025',
      ...message,
    },
    { wa_id: '5511999999999', profile: { name: 'Cliente' } },
  );

describe('WhatsAppOfficialMessageMapper — tipos que caíam no fallback', () => {
  it('resposta a botão de template vira o texto do botão', () => {
    const out = parse({
      type: 'button',
      button: { text: 'Quero participar', payload: 'SIM_QUERO' },
    });

    expect(out?.content).toEqual({
      interactive: { type: 'button', buttonId: 'SIM_QUERO' },
      text: 'Quero participar',
    });
  });

  it('cartão de contato vira nome + telefone legíveis', () => {
    const out = parse({
      type: 'contacts',
      contacts: [
        {
          name: { formatted_name: 'Kelson Andrade' },
          phones: [{ phone: '+55 86 9915-0425', wa_id: '558699150425' }],
        },
      ],
    });

    expect(out?.content.text).toBe('Contato: Kelson Andrade\n+55 86 9915-0425');
  });

  it('permissão de chamada vira frase, não bolha vazia', () => {
    const aceito = parse({
      type: 'interactive',
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: { response: 'accept' },
      },
    });
    expect(aceito?.content.text).toBe('Permitiu chamadas de voz');

    const recusado = parse({
      type: 'interactive',
      interactive: {
        type: 'call_permission_reply',
        call_permission_reply: { response: 'reject' },
      },
    });
    expect(recusado?.content.text).toBe('Recusou chamadas de voz');
  });

  it('mantém o que já funcionava: button_reply e list_reply', () => {
    expect(
      parse({
        type: 'interactive',
        interactive: {
          type: 'button_reply',
          button_reply: { id: 'b1', title: 'Sim' },
        },
      })?.content,
    ).toEqual({ interactive: { type: 'button', buttonId: 'b1' }, text: 'Sim' });

    expect(
      parse({
        type: 'interactive',
        interactive: {
          type: 'list_reply',
          list_reply: { id: 'r1', title: 'Opção 1' },
        },
      })?.content,
    ).toEqual({ interactive: { type: 'list', listRowId: 'r1' }, text: 'Opção 1' });
  });
});
