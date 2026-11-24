import {
  eligiblePlatforms,
  hashPhone,
  ineligibilityReason,
  normalizePhone,
  parseClickRef,
  readOriginFacts,
  stripClickRef,
} from './origin';

describe('origem do lead — leitura do marcador', () => {
  it('lê o gclid embutido na mensagem', () => {
    const ref = parseClickRef(
      'Olá, vim pelo site e quero orientação. GT:g.Cj0KCQiA_abc-123',
    );
    expect(ref).toEqual({ kind: 'gclid', value: 'Cj0KCQiA_abc-123' });
  });

  it('reconhece as quatro letras de tipo', () => {
    expect(parseClickRef('x GT:b.abcdefghij1')?.kind).toBe('gbraid');
    expect(parseClickRef('x GT:w.abcdefghij1')?.kind).toBe('wbraid');
    expect(parseClickRef('x GT:f.abcdefghij1')?.kind).toBe('fbclid');
  });

  it('ignora identificador curto, longo ou com caractere estranho', () => {
    expect(parseClickRef('GT:g.curto')).toBeNull();
    expect(parseClickRef(`GT:g.${'a'.repeat(201)}`)).toBeNull();
    expect(parseClickRef('GT:g.abc$def$ghi')).toBeNull();
  });

  it('só lê o identificador que termina em espaço, pontuação ou fim', () => {
    expect(parseClickRef('GT:g.abcdefghij1.')?.value).toBe('abcdefghij1');
    expect(parseClickRef('(ref. GT:g.abcdefghij1)')?.value).toBe('abcdefghij1');
  });

  it('tira o marcador do texto que vai para o inbox', () => {
    const limpo = stripClickRef(
      'Olá, vim pelo site sobre trabalhista. GT:g.Cj0KCQiA_abc-123',
    );
    expect(limpo).toBe('Olá, vim pelo site sobre trabalhista.');
    expect(limpo).not.toContain('GT:');
  });

  it('devolve o texto intacto quando não há marcador', () => {
    expect(stripClickRef('Bom dia, preciso de ajuda')).toBe(
      'Bom dia, preciso de ajuda',
    );
  });
});

describe('telefone', () => {
  it('completa o DDI do número brasileiro', () => {
    expect(normalizePhone('(54) 99196-2299')).toBe('5554991962299');
    expect(normalizePhone('5554991962299')).toBe('5554991962299');
  });

  it('recusa o que não dá para normalizar com segurança', () => {
    expect(normalizePhone('123')).toBeNull();
    expect(normalizePhone('')).toBeNull();
    expect(normalizePhone(null)).toBeNull();
  });

  it('o hash é determinístico e não devolve o número', () => {
    const a = hashPhone('(54) 99196-2299');
    const b = hashPhone('5554991962299');
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
    expect(a).not.toContain('99196');
  });
});

describe('plataformas elegíveis', () => {
  it('Google só com identificador de clique do Google', () => {
    const facts = readOriginFacts({
      contactMetadata: { origin: 'google-ads', clickKind: 'gclid', clickId: 'abcdefghij1' },
      phone: '54991962299',
    });
    const matches = eligiblePlatforms(facts);
    expect(matches).toEqual([
      { platform: 'GOOGLE', matchKind: 'gclid', matchValue: 'abcdefghij1' },
    ]);
  });

  it('origem do Google sem clique não devolve nada, e diz por quê', () => {
    const facts = readOriginFacts({
      contactMetadata: { origin: 'google-ads' },
      phone: '54991962299',
    });
    expect(eligiblePlatforms(facts)).toHaveLength(0);
    expect(ineligibilityReason(facts)).toMatch(/aguardando gclid/);
  });

  it('campanha da Meta casa por hash do telefone', () => {
    const facts = readOriginFacts({
      contactMetadata: { origin: 'dm01' },
      phone: '54991962299',
    });
    const matches = eligiblePlatforms(facts);
    expect(matches).toHaveLength(1);
    expect(matches[0].platform).toBe('META');
    expect(matches[0].matchKind).toBe('phone_hash');
    expect(matches[0].matchValue).toHaveLength(64);
  });

  it('com ctwa_clid a Meta casa pelo clique, sem dado pessoal', () => {
    const facts = readOriginFacts({
      contactMetadata: { origin: 'dm01', clickKind: 'ctwa_clid', clickId: 'ctwa_abc123456' },
      phone: '54991962299',
    });
    const matches = eligiblePlatforms(facts);
    expect(matches).toEqual([
      { platform: 'META', matchKind: 'ctwa_clid', matchValue: 'ctwa_abc123456' },
    ]);
  });

  it('lead do site, sem código de anúncio, não vira evento em plataforma', () => {
    const facts = readOriginFacts({
      contactMetadata: { origin: 'site-direito-medico' },
      phone: '54991962299',
    });
    expect(eligiblePlatforms(facts)).toHaveLength(0);
    expect(ineligibilityReason(facts)).toMatch(/não mapeada/);
  });

  it('lead orgânico não vira evento nenhum', () => {
    const facts = readOriginFacts({ phone: '54991962299' });
    expect(eligiblePlatforms(facts)).toHaveLength(0);
    expect(ineligibilityReason(facts)).toMatch(/sem origem registrada/);
  });

  it('o card tem precedência sobre o contato', () => {
    const facts = readOriginFacts({
      contactMetadata: { origin: 'dm01' },
      cardMetadata: { origin: 'TR02' },
      phone: '54991962299',
    });
    expect(facts.campaignCode).toBe('tr02');
  });

  it('sem telefone, campanha da Meta não tem como casar', () => {
    const facts = readOriginFacts({ contactMetadata: { origin: 'dm01' }, phone: null });
    expect(eligiblePlatforms(facts)).toHaveLength(0);
    expect(ineligibilityReason(facts)).toMatch(/não tem telefone/);
  });
});

describe('códigos que estão no ar na conta', () => {
  // Os quatro prefixos em veiculação em 23/11/2026. TE ficou de fora na
  // primeira versão e lead de trabalhista-empregado não devolvia conversão.
  it.each(['dm01', 'dmvid', 'tr02', 'te03', 'ag01'])(
    'código %s é reconhecido como campanha da Meta',
    (code) => {
      const facts = readOriginFacts({
        contactMetadata: { origin: code },
        phone: '54991962299',
      });
      const matches = eligiblePlatforms(facts);
      expect(matches.map((m) => m.platform)).toEqual(['META']);
    },
  );
});
