import { Injectable } from '@nestjs/common';
import { Instrument } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_RESULTS = 20;

@Injectable()
export class InstrumentsService {
  constructor(private readonly prisma: PrismaService) {}

  search(q: string): Promise<Instrument[]> {
    return this.prisma.$queryRaw<Instrument[]>`
      SELECT id, ticker, name, type
      FROM instruments
      WHERE type IS DISTINCT FROM 'MONEDA'
        AND (ticker ILIKE ${`%${q}%`} OR name ILIKE ${`%${q}%`})
      ORDER BY
        CASE
          WHEN ticker ILIKE ${q} THEN 0
          WHEN ticker ILIKE ${`${q}%`} THEN 1
          ELSE 2
        END,
        ticker
      LIMIT ${MAX_RESULTS}
    `;
  }
}
