import { Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PortfolioRepository } from './portfolio.repository';

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

    const totalValue = holdings.reduce(
      (total, holding) => total.plus(holding.marketValue),
      cash,
    );

    return {
      totalValue: totalValue.toFixed(2),
      availableCash: cash.toFixed(2),
      positions: holdings.map((holding) => ({
        ...holding,
        marketValue: holding.marketValue.toFixed(2),
        avgCost: holding.avgCost?.toFixed(2) ?? null,
        totalReturnPct: holding.totalReturnPct?.toFixed(2) ?? null,
      })),
    };
  }
}
