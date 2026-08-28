import { Injectable } from '@nestjs/common';
import { Instrument } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InstrumentsRepository {
  constructor(private readonly prisma: PrismaService) {}

  // `position` and `starts_with` compare strings, not patterns, so `%`, `_` and `\` are
  // literal characters and nothing needs escaping on the way in.
  search(term: string, limit: number): Promise<Instrument[]> {
    return this.prisma.$queryRaw<Instrument[]>`
      SELECT id, ticker, name, type
      FROM instruments
      WHERE type IS DISTINCT FROM 'MONEDA'
        AND (position(lower(${term}) in lower(ticker)) > 0
          OR position(lower(${term}) in lower(name)) > 0)
      ORDER BY
        CASE
          WHEN lower(ticker) = lower(${term}) THEN 0
          WHEN starts_with(lower(ticker), lower(${term})) THEN 1
          ELSE 2
        END,
        ticker
      LIMIT ${limit}
    `;
  }
}
