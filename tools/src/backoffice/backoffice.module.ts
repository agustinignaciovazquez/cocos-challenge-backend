import { Module } from '@nestjs/common';
import { ChaosModule } from '../chaos/chaos.module';
import { GatewayModule } from '../gateway/gateway.module';
import { SimulationModule } from '../simulation/simulation.module';
import { AnomaliesModule } from './anomalies.module';
import { BackofficeController } from './backoffice.controller';
import { BackofficeService } from './backoffice.service';
import { Reconciler } from './reconciler';

@Module({
  imports: [GatewayModule, SimulationModule, ChaosModule, AnomaliesModule],
  controllers: [BackofficeController],
  providers: [BackofficeService, Reconciler],
  exports: [AnomaliesModule, BackofficeService, Reconciler],
})
export class BackofficeModule {}
