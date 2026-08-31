import { Module } from '@nestjs/common';
import { GatewayModule } from '../gateway/gateway.module';
import { HistoryModule } from '../history/history.module';
import { SimulationController } from './simulation.controller';
import { SimulationService } from './simulation.service';

@Module({
  imports: [GatewayModule, HistoryModule],
  controllers: [SimulationController],
  providers: [SimulationService],
  exports: [SimulationService],
})
export class SimulationModule {}
