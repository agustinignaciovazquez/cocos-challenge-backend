import { Injectable } from '@nestjs/common';
import { Instrument } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const MAX_RESULTS = 20;

// ILIKE reads `%` and `_` as wildcards and `\` as their escape. The term is a literal, so
// its own copies of the three are escaped: otherwise a search says more than it looks like
// it says, and a trailing `\` builds a pattern Postgres refuses outright.
const escapeLike = (term: string): string => term.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class InstrumentsService {
  constructor(private readonly prisma: PrismaService) {}

  search(query: string): Promise<Instrument[]> {
    const q = escapeLike(query);

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
