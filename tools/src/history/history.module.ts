import { Module } from '@nestjs/common';
import { AnomaliesModule } from '../backoffice/anomalies.module';
import { ChaosModule } from '../chaos/chaos.module';
import { StoreModule } from '../store/store.module';
import { HistoryController } from './history.controller';
import { HistoryService } from './history.service';

// Below the engines it records: the writer only needs the two stores it taps and the chaos
// state it stamps onto a manifest, so the simulation and the load engine can both open a run
// without either of them and the writer waiting on the other.
@Module({
  imports: [StoreModule, AnomaliesModule, ChaosModule],
  controllers: [HistoryController],
  providers: [HistoryService],
  exports: [HistoryService],
})
export class HistoryModule {}
