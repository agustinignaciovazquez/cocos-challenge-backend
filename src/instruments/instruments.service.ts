import { Injectable } from '@nestjs/common';
import { Instrument } from '@prisma/client';
import { InstrumentsRepository } from './instruments.repository';

const MAX_RESULTS = 20;

@Injectable()
export class InstrumentsService {
  constructor(private readonly repository: InstrumentsRepository) {}

  search(query: string): Promise<Instrument[]> {
    return this.repository.search(query, MAX_RESULTS);
  }
}
