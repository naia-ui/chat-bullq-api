import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { GoogleSheetsAuthService } from './google-sheets-auth.service';
import { GoogleSheetsClientService } from './google-sheets-client.service';
import { LeadsSheetSyncCron } from './leads-sheet-sync.cron';
import { LEADS_SHEET_SYNC_QUEUE } from './leads-sheet-sync.constants';

@Module({
  imports: [BullModule.registerQueue({ name: LEADS_SHEET_SYNC_QUEUE })],
  providers: [
    GoogleSheetsAuthService,
    GoogleSheetsClientService,
    LeadsSheetSyncCron,
  ],
})
export class SheetsSyncModule {}
