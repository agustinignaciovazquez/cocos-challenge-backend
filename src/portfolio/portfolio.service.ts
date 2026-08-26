import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { apiString, centavosFromDb } from '../money';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioRepository } from './portfolio.repository';

const twoDecimals = (value: Prisma.Decimal | null): string | null =>
  value === null ? null : apiString(centavosFromDb(value));

export type Position = {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  marketValue: string;
  avgCost: string | null;
  totalReturnPct: string | null;
};

export type Portfolio = {
  totalValue: string;
  availableCash: string;
  positions: Position[];
};

@Injectable()
export class PortfolioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: PortfolioRepository,
  ) {}

  async forUser(userId: number): Promise<Portfolio> {
    if (!(await this.repository.userExists(userId))) {
      throw new NotFoundException(`User ${userId} not found`);
    }

    // Repeatable read: cash and holdings come from one snapshot, so an order settling
    // mid-request cannot be counted in both halves of totalValue, or in neither.
    const { cash, holdings } = await this.prisma.$transaction(
      async (tx) => ({
        cash: await this.repository.availableCash(userId, tx),
        holdings: await this.repository.holdings(userId, tx),
      }),
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );

    const availableCash = centavosFromDb(cash);
    const totalValue = holdings.reduce(
      (total, holding) => total + centavosFromDb(holding.marketValue),
      availableCash,
    );

    return {
      totalValue: apiString(totalValue),
      availableCash: apiString(availableCash),
      positions: holdings.map((holding) => ({
        ...holding,
        marketValue: apiString(centavosFromDb(holding.marketValue)),
        avgCost: twoDecimals(holding.avgCost),
        totalReturnPct: twoDecimals(holding.totalReturnPct),
      })),
    };
  }
}
