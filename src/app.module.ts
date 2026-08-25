import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { InstrumentsModule } from './instruments/instruments.module';
import { OrdersModule } from './orders/orders.module';
import { PortfolioModule } from './portfolio/portfolio.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, InstrumentsModule, OrdersModule, PortfolioModule],
  controllers: [AppController],
})
export class AppModule {}
