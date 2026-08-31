import { Module } from '@nestjs/common';
import { ChaosModule } from '../chaos/chaos.module';
import { AnomaliesStore } from './anomalies.store';

// The findings store on its own, for the same reason the recorder has its own module: the run
// history writes every anomaly to disk, and it must be able to have this store without also
// having the back-office that fills it — which is built on top of the simulation.
@Module({
  imports: [ChaosModule],
  providers: [AnomaliesStore],
  exports: [AnomaliesStore],
})
export class AnomaliesModule {}
