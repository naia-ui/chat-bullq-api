import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../../database/prisma.service';
import { HandoffNotificationsService } from './handoff-notifications.service';

/**
 * Efetiva de verdade um handoff pra humano: pausa a IA na conversa, cria/
 * move o card no pipeline certo, e dispara os dois avisos best-effort
 * (cliente fora do horário humano + ping interno pro time).
 *
 * Extraído do `PendingActionExecutorProcessor` em 17/08/2026 quando o
 * `transferToHuman` deixou de exigir aprovação manual no painel antes de
 * executar (decisão: "IA qualifica e repassa direto, sem clique" — 24/7
 * sem alguém sempre de olho no painel, esperar aprovação travava o
 * atendimento de verdade). Continua reaproveitado pelo processor pra
 * qualquer PendingAction de transferToHuman que ainda exista por outro
 * caminho (ex.: criada manualmente via API).
 */
@Injectable()
export class HandoffExecutionService {
  private readonly logger = new Logger(HandoffExecutionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly handoffNotifications: HandoffNotificationsService,
  ) {}

  async execute(params: {
    conversationId: string;
    agentId: string;
    reason: string | null;
  }): Promise<{ ok: true; transferredAt: string; reason: string | null }> {
    const { conversationId, agentId, reason } = params;

    // Pausa a IA na conversa + sinaliza que aguarda atendente humano.
    await this.prisma.conversation.update({
      where: { id: conversationId },
      data: { aiEnabled: false },
    });

    await this.upsertHandoffCard(conversationId, agentId, reason);

    // Dois avisos best-effort — nenhum dos dois pode derrubar o handoff em
    // si (erro é só logado dentro de cada método, nunca relançado aqui).
    await this.handoffNotifications.notifyClientIfOutsideHumanHours(
      conversationId,
    );
    await this.alertInternalTeamAboutHandoff(conversationId, reason);

    return {
      ok: true,
      transferredAt: new Date().toISOString(),
      reason,
    };
  }

  private async alertInternalTeamAboutHandoff(
    conversationId: string,
    reason: string | null,
  ): Promise<void> {
    const conversation = await this.prisma.conversation.findUnique({
      where: { id: conversationId },
      include: { contact: { select: { name: true, phone: true } } },
    });
    if (!conversation) return;
    const contactName =
      conversation.contact?.name ?? conversation.contact?.phone ?? 'Contato';
    await this.handoffNotifications.alertInternalTeam(
      conversationId,
      contactName,
      reason,
    );
  }

  /**
   * Handoff pra humano dispara DOIS efeitos no kanban:
   *
   *  1. Se existe um card OPEN no funil de leads (pipeline `isDefault`) pra
   *     esse contato, avança pra etapa de qualificação (WON) — o lead
   *     "se formou" em caso.
   *  2. Cria/move o card no pipeline de CASO da área (`aiAgent.pipelineId`
   *     do agente que pediu o handoff). Sem pipeline mapeado pro agente,
   *     cai de volta no funil de leads (comportamento antigo, pré-multi-
   *     pipeline) — nunca perde o card por falta de mapeamento.
   *
   * Best-effort nos dois passos — nunca deve derrubar o handoff em si,
   * qualquer erro aqui só é logado. Idempotente: repetir o handoff da
   * mesma conversa só move os cards existentes, não duplica.
   */
  private async upsertHandoffCard(
    conversationId: string,
    agentId: string,
    reason: string | null,
  ): Promise<void> {
    try {
      const conversation = await this.prisma.conversation.findUnique({
        where: { id: conversationId },
        select: { organizationId: true, contactId: true },
      });
      if (!conversation) return;

      const leadsPipeline = await this.prisma.pipeline.findFirst({
        where: {
          organizationId: conversation.organizationId,
          isDefault: true,
          archived: false,
        },
        include: { stages: true },
      });

      // Passo 1: avança o card de lead (se existir) pra etapa de
      // qualificação — primeiro stage WON do funil de leads.
      if (leadsPipeline) {
        const qualifiedStage = leadsPipeline.stages.find(
          (s) => s.type === 'WON',
        );
        if (qualifiedStage) {
          await this.prisma.card
            .updateMany({
              where: {
                organizationId: conversation.organizationId,
                pipelineId: leadsPipeline.id,
                contactId: conversation.contactId,
                status: 'OPEN',
              },
              data: { stageId: qualifiedStage.id },
            })
            .catch((err) =>
              this.logger.warn(
                `Failed to advance leads card for conv ${conversationId}: ${err?.message ?? err}`,
              ),
            );
        }
      }

      // Passo 2: pipeline de caso da área — vem do agente que transferiu.
      // Sem mapeamento, cai no funil de leads (comportamento pré-existente).
      const agent = await this.prisma.aiAgent.findUnique({
        where: { id: agentId },
        select: { pipelineId: true },
      });
      const casePipeline = agent?.pipelineId
        ? await this.prisma.pipeline.findFirst({
            where: {
              id: agent.pipelineId,
              organizationId: conversation.organizationId,
              archived: false,
            },
            include: { stages: true },
          })
        : leadsPipeline;
      if (!casePipeline) return;

      const stage = casePipeline.stages
        .filter((s) => s.type === 'NORMAL')
        .sort((a, b) => a.order - b.order)[0];
      if (!stage) return;

      const existing = await this.prisma.card.findFirst({
        where: {
          organizationId: conversation.organizationId,
          pipelineId: casePipeline.id,
          contactId: conversation.contactId,
          status: 'OPEN',
        },
      });

      if (existing) {
        await this.prisma.card.update({
          where: { id: existing.id },
          data: { stageId: stage.id, conversationId },
        });
        return;
      }

      const contact = await this.prisma.contact.findUnique({
        where: { id: conversation.contactId },
        select: { name: true, phone: true },
      });
      const title = contact?.name || contact?.phone || 'Novo contato';

      await this.prisma.card.create({
        data: {
          organizationId: conversation.organizationId,
          pipelineId: casePipeline.id,
          stageId: stage.id,
          title,
          description: reason,
          contactId: conversation.contactId,
          conversationId,
          status: 'OPEN',
          metadata: { createdBy: 'transferToHuman' },
        },
      });
    } catch (err: any) {
      this.logger.warn(
        `Failed to create/move handoff pipeline card for conversation ${conversationId}: ${err?.message ?? err}`,
      );
    }
  }
}
