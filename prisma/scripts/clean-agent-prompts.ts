/**
 * Fase 2.5 — limpeza de systemPrompts duplicados (vide PROMPTS-AUDIT.md)
 *
 * Com a Layer 1 SECURITY agora ativa no prompt composer (a cada request),
 * as regras universais (zero emoji, sem CAPS, sem travessão, handoff invisível,
 * etc) NÃO precisam mais estar no systemPrompt de cada agent. Esse script
 * detecta padrões duplicados e gera um preview do que pode ser removido.
 *
 * USAGE
 *   # Conecte no DB que quer limpar (DATABASE_URL apontando pra dev/prod):
 *   npx ts-node prisma/scripts/clean-agent-prompts.ts            # dry-run (preview)
 *   npx ts-node prisma/scripts/clean-agent-prompts.ts --apply    # aplica UPDATE
 *
 * O script é IDEMPOTENTE — rodar de novo após --apply detecta que já está
 * limpo e não muda nada.
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Padrões que devem ser REMOVIDOS dos systemPrompts (já cobertos pela
 * Security Layer). Cada item é uma regex case-insensitive multilinha que,
 * se matchar, é apagada com a linha inteira.
 */
const REDUNDANT_LINE_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'forbidden emojis (lista)', pattern: /^.*emojis?[^.\n]*?(👋|🙏|✅|🎉|✨|🤝|📊|📈)[^.\n]*$/gim },
  { name: 'zero emoji rule', pattern: /^.*\b(zero|0|nenhum|sem)\s+emoji.*$/gim },
  { name: 'sem CAPS LOCK', pattern: /^.*\bnunca.*\b(CAPS|caixa[- ]?alta).*$/gim },
  { name: 'não dizer que é IA', pattern: /^.*\b(nunca|n[aã]o)\s+(diga|dizer|fal[ae]).*\b(IA|inteligência\s+artificial|robô|bot|automação|assistente\s+virtual).*$/gim },
  { name: 'frases curtas WhatsApp', pattern: /^.*\b(frases?\s+curtas?|1\s+a\s+3\s+linhas?|whatsapp.*linhas?|brevidade).*$/gim },
  { name: 'sem travessão', pattern: /^.*\b(travessão|"—"|sem\s+travess).*$/gim },
  { name: 'sem reticências', pattern: /^.*\b(reticências|"…"|"\.\.\.\").*$/gim },
  { name: 'pt-BR explícito', pattern: /^.*\b(responda|sempre)\s+em\s+português.*$/gim },
  { name: 'handoff cita orchestrator', pattern: /^.*\bo\s+Augusto\s+(me\s+passou|te\s+passou).*$/gim },
];

/**
 * Padrões que NÃO devem ficar mas exigem revisão humana (avisar, não cortar).
 */
const SUSPICIOUS_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'preço hardcoded', pattern: /R\$\s*\d{2,}/g },
  { name: 'prazo específico', pattern: /em\s+\d+\s+dias?/gi },
  { name: 'auto-apresentação worker', pattern: /\b(aqui\s+é\s+o|aqui\s+é\s+a)\s+\w+/gi },
];

interface CleanupReport {
  agentId: string;
  agentName: string;
  originalLength: number;
  cleanedLength: number;
  removed: { pattern: string; lines: string[] }[];
  warnings: { pattern: string; matches: string[] }[];
}

function cleanPrompt(prompt: string): {
  cleaned: string;
  removed: { pattern: string; lines: string[] }[];
} {
  let working = prompt;
  const removed: { pattern: string; lines: string[] }[] = [];

  for (const { name, pattern } of REDUNDANT_LINE_PATTERNS) {
    const matches = working.match(pattern);
    if (matches && matches.length > 0) {
      removed.push({ pattern: name, lines: matches });
      working = working.replace(pattern, '').replace(/\n{3,}/g, '\n\n');
    }
  }

  return { cleaned: working.trim(), removed };
}

function findWarnings(prompt: string): { pattern: string; matches: string[] }[] {
  const warnings: { pattern: string; matches: string[] }[] = [];
  for (const { name, pattern } of SUSPICIOUS_PATTERNS) {
    const matches = prompt.match(pattern);
    if (matches && matches.length > 0) {
      warnings.push({ pattern: name, matches: Array.from(new Set(matches)) });
    }
  }
  return warnings;
}

async function main() {
  const apply = process.argv.includes('--apply');
  console.log(apply ? '🚀 MODO APPLY (vai escrever no DB)' : '👀 MODO DRY-RUN (preview)');
  console.log('---');

  const agents = await prisma.aiAgent.findMany({
    where: { isActive: true, deletedAt: null },
    select: { id: true, name: true, systemPrompt: true },
    orderBy: { name: 'asc' },
  });

  if (agents.length === 0) {
    console.log('Nenhum agent ativo encontrado.');
    return;
  }

  const reports: CleanupReport[] = [];
  let totalSaved = 0;

  for (const agent of agents) {
    if (!agent.systemPrompt) continue;
    const { cleaned, removed } = cleanPrompt(agent.systemPrompt);
    const warnings = findWarnings(agent.systemPrompt);
    const saved = agent.systemPrompt.length - cleaned.length;
    totalSaved += saved;

    reports.push({
      agentId: agent.id,
      agentName: agent.name,
      originalLength: agent.systemPrompt.length,
      cleanedLength: cleaned.length,
      removed,
      warnings,
    });

    console.log(`\n📝 ${agent.name} (${agent.id})`);
    console.log(`   Original: ${agent.systemPrompt.length} chars / Limpo: ${cleaned.length} chars (-${saved})`);
    if (removed.length === 0) {
      console.log('   ✓ Já está limpo');
    } else {
      for (const r of removed) {
        console.log(`   - [removido] ${r.pattern}: ${r.lines.length} linha(s)`);
        for (const line of r.lines.slice(0, 2)) {
          console.log(`     "${line.trim().slice(0, 100)}"`);
        }
      }
    }
    if (warnings.length > 0) {
      console.log(`   ⚠️  Avisos (revisão humana):`);
      for (const w of warnings) {
        console.log(`     ${w.pattern}: ${w.matches.slice(0, 3).join(', ')}`);
      }
    }

    if (apply && removed.length > 0) {
      await prisma.aiAgent.update({
        where: { id: agent.id },
        data: { systemPrompt: cleaned },
      });
      console.log('   ✅ APPLIED');
    }
  }

  console.log('\n═══════════════════════════════════════════');
  console.log(`Total: ${agents.length} agents, ${totalSaved} chars economizados (~${Math.ceil(totalSaved / 4)} tokens por chamada)`);
  console.log(apply ? '✅ Mudanças aplicadas no DB' : '👀 Dry-run completo. Use --apply pra escrever.');
  console.log('═══════════════════════════════════════════');
}

main()
  .catch((e) => {
    console.error('Erro:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
