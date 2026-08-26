import { Module } from '@nestjs/common';
import { InstrumentsController } from './instruments.controller';
import { InstrumentsRepository } from './instruments.repository';
import { InstrumentsService } from './instruments.service';

@Module({
  controllers: [InstrumentsController],
  providers: [InstrumentsService, InstrumentsRepository],
})
export class InstrumentsModule {}
