import { Module } from '@nestjs/common';
import { PipelinesController } from './pipelines.controller';
import { PipelinesService } from './pipelines.service';
import { RealtimeModule } from '../realtime/realtime.module';
import { SheetsSyncModule } from './sheets-sync/sheets-sync.module';

@Module({
  imports: [RealtimeModule, SheetsSyncModule],
  controllers: [PipelinesController],
  providers: [PipelinesService],
  exports: [PipelinesService],
})
export class PipelinesModule {}
