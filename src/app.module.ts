import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { InstrumentsModule } from './instruments/instruments.module';
import { PrismaModule } from './prisma/prisma.module';

@Module({
  imports: [PrismaModule, InstrumentsModule],
  controllers: [AppController],
})
export class AppModule {}
