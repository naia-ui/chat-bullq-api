import { LeadOriginService } from './lead-origin.service';

/**
 * `detect()` é pura: lê o marcador e devolve o texto limpo. Instanciar sem
 * banco e sem outbox é de propósito — nada aqui escreve.
 */
const service = new LeadOriginService(null as any, null as any);

describe('detecção de origem na primeira mensagem', () => {
  it('lê o código do anúncio da Meta e não mexe no texto', () => {
    const r = service.detect(
      'Olá! Recebi uma notificação do CRM e gostaria de orientação. (ref. DM01)',
    );
    expect(r.originSlug).toBe('dm01');
    expect(r.clickRef).toBeNull();
    // O time precisa ver o código no inbox.
    expect(r.cleanedText).toContain('(ref. DM01)');
  });

  it('lê o slug do site e tira o marcador do texto', () => {
    const r = service.detect(
      'Olá, vim do site sobre Direito Médico #origem:site-direito-medico',
    );
    expect(r.originSlug).toBe('site-direito-medico');
    expect(r.cleanedText).toBe('Olá, vim do site sobre Direito Médico');
  });

  it('lê o gclid junto com o slug e limpa os dois marcadores', () => {
    const r = service.detect(
      'Olá, vim pelo site GT:g.Cj0KCQiA_abc-123 #origem:site-trabalhista',
    );
    expect(r.originSlug).toBe('site-trabalhista');
    expect(r.clickRef).toEqual({ kind: 'gclid', value: 'Cj0KCQiA_abc-123' });
    expect(r.cleanedText).toBe('Olá, vim pelo site');
  });

  it('gclid sozinho, sem slug, ainda é origem', () => {
    const r = service.detect('Bom dia, preciso de orientação. GT:g.Cj0KCQiA_abc-123');
    expect(r.originSlug).toBeNull();
    expect(r.clickRef?.kind).toBe('gclid');
    expect(r.cleanedText).toBe('Bom dia, preciso de orientação.');
  });

  it('mensagem comum não ganha origem nenhuma', () => {
    const r = service.detect('Bom dia, vocês atendem em Porto Alegre?');
    expect(r.originSlug).toBeNull();
    expect(r.clickRef).toBeNull();
    expect(r.cleanedText).toBe('Bom dia, vocês atendem em Porto Alegre?');
  });

  it('identificador deformado é ignorado e não contamina o registro', () => {
    const r = service.detect('Olá GT:g.curto #origem:site-trabalhista');
    expect(r.clickRef).toBeNull();
    expect(r.originSlug).toBe('site-trabalhista');
  });
});
