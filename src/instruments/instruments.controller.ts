import { Controller, Get, Query } from '@nestjs/common';
import { Instrument } from '@prisma/client';
import { InstrumentsService } from './instruments.service';
import { SearchInstrumentsDto } from './search-instruments.dto';

@Controller('instruments')
export class InstrumentsController {
  constructor(private readonly instruments: InstrumentsService) {}

  @Get()
  search(@Query() query: SearchInstrumentsDto): Promise<Instrument[]> {
    return this.instruments.search(query.q);
  }
}
