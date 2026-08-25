import { Module } from '@nestjs/common';
import { PortfolioModule } from '../portfolio/portfolio.module';
import { OrdersController } from './orders.controller';
import { OrdersService } from './orders.service';

@Module({
  imports: [PortfolioModule],
  controllers: [OrdersController],
  providers: [OrdersService],
})
export class OrdersModule {}
