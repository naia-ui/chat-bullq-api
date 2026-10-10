import { matchesMedicalLawTrigger } from './medical-law-gate';

describe('matchesMedicalLawTrigger', () => {
  it.each([
    'Recebi uma notificação do CRM',
    'abriram sindicância contra mim',
    'Preciso do prontuário da minha mãe',
    'sofri erro médico',
    'Fui citada em processo ético',
    'Sou médica e preciso de ajuda',
    'MÉDICO',
  ])('dispara em "%s"', (text) => {
    expect(matchesMedicalLawTrigger(text)).toBe(true);
  });

  it.each([
    'Recebi uma notificação do banco',
    'fui demitido sem justa causa',
    'meu CRMV não existe',
    'comédico',
    '',
    null,
  ])('não dispara em "%s"', (text) => {
    expect(matchesMedicalLawTrigger(text as string | null)).toBe(false);
  });
});
