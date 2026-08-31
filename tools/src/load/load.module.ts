import { Module } from '@nestjs/common';
import { BackofficeModule } from '../backoffice/backoffice.module';
import { GatewayModule } from '../gateway/gateway.module';
import { HistoryModule } from '../history/history.module';
import { SimulationModule } from '../simulation/simulation.module';
import { LoadController } from './load.controller';
import { LoadService } from './load.service';

@Module({
  imports: [GatewayModule, SimulationModule, BackofficeModule, HistoryModule],
  controllers: [LoadController],
  providers: [LoadService],
})
export class LoadModule {}
