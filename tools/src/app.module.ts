import { Module } from '@nestjs/common';
import { BackofficeModule } from './backoffice/backoffice.module';
import { ChaosModule } from './chaos/chaos.module';
import { GatewayModule } from './gateway/gateway.module';
import { HistoryModule } from './history/history.module';
import { LoadModule } from './load/load.module';
import { SimulationModule } from './simulation/simulation.module';

@Module({
  imports: [
    GatewayModule,
    SimulationModule,
    BackofficeModule,
    LoadModule,
    ChaosModule,
    HistoryModule,
  ],
})
export class AppModule {}
