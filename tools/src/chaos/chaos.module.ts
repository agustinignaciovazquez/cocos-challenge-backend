import { Module } from '@nestjs/common';
import { StoreModule } from '../store/store.module';
import { ChaosController } from './chaos.controller';
import { ChaosService } from './chaos.service';

@Module({
  imports: [StoreModule],
  controllers: [ChaosController],
  providers: [ChaosService],
  exports: [ChaosService],
})
export class ChaosModule {}
