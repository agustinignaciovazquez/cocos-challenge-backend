import { Module } from '@nestjs/common';
import { ChaosModule } from '../chaos/chaos.module';
import { StoreModule } from '../store/store.module';
import { GatewayController } from './gateway.controller';
import { GatewayService } from './gateway.service';

@Module({
  imports: [StoreModule, ChaosModule],
  controllers: [GatewayController],
  providers: [GatewayService],
  exports: [StoreModule, GatewayService],
})
export class GatewayModule {}
