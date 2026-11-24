import { BullModule } from '@nestjs/bullmq';
import { Global, Module } from '@nestjs/common';
import { PrismaModule } from '../../database/prisma.module';
import { ConversionsDispatchCron } from './conversions-dispatch.cron';
import { ConversionsConfigService } from './conversions.config';
import { ConversionsController } from './conversions.controller';
import { ConversionsService } from './conversions.service';
import { GoogleAdsAdapter } from './adapters/google-ads.adapter';
import { MetaCapiAdapter } from './adapters/meta-capi.adapter';
import { CONVERSIONS_QUEUE } from './conversions.constants';

/**
 * Fase 6 do funil de captação (ver CONVERSOES.md): devolver o contrato
 * assinado à plataforma que trouxe o lead.
 *
 * Global porque o motor de automação (`send_conversion`) e o movimento do
 * card (cancelar conversão pendente) injetam o serviço. Não importa nada de
 * automations nem de pipelines — a dependência é de mão única, sem ciclo.
 */
@Global()
@Module({
  imports: [
    PrismaModule,
    BullModule.registerQueue({ name: CONVERSIONS_QUEUE }),
  ],
  controllers: [ConversionsController],
  providers: [
    ConversionsConfigService,
    MetaCapiAdapter,
    GoogleAdsAdapter,
    ConversionsService,
    ConversionsDispatchCron,
  ],
  exports: [ConversionsService, ConversionsConfigService],
})
export class ConversionsModule {}
