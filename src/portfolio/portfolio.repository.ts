import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type Holding = {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  marketValue: Prisma.Decimal;
  avgCost: Prisma.Decimal | null;
  totalReturnPct: Prisma.Decimal | null;
};

@Injectable()
export class PortfolioRepository {
  constructor(private readonly prisma: PrismaService) {}

  async userExists(
    userId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<boolean> {
    const user = await db.user.findUnique({
      where: { id: userId },
      select: { id: true },
    });
    return user !== null;
  }

  // The folds live in the views (db/init.sql). A fold that came to nothing leaves no row,
  // so the missing row is the zero.
  async availableCash(
    userId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const [{ cash }] = await db.$queryRaw<[{ cash: Prisma.Decimal }]>`
      SELECT COALESCE(
        (SELECT cash FROM cash_balances WHERE userid = ${userId}), 0
      ) AS cash
    `;
    return cash;
  }

  async heldShares(
    userId: number,
    instrumentId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    const [{ shares }] = await db.$queryRaw<[{ shares: number }]>`
      SELECT COALESCE(
        (SELECT quantity FROM holdings
          WHERE userid = ${userId} AND instrumentid = ${instrumentId}), 0
      ) AS shares
    `;
    return shares;
  }

  holdings(
    userId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Holding[]> {
    return db.$queryRaw<Holding[]>`
      SELECT
        h.instrumentid AS "instrumentId",
        i.ticker,
        i.name,
        h.quantity,
        ROUND(h.quantity * COALESCE(c.close, 0), 2) AS "marketValue",
        ROUND(h.avg_cost, 2) AS "avgCost",
        CASE WHEN h.quantity > 0 AND h.avg_cost > 0 AND c.close IS NOT NULL
          THEN ROUND((c.close - h.avg_cost) / h.avg_cost * 100, 2)
        END AS "totalReturnPct"
      FROM holdings h
      JOIN instruments i ON i.id = h.instrumentid
      LEFT JOIN latest_closes c ON c.instrumentid = h.instrumentid
      -- Cash is the availableCash line, never a position.
      WHERE h.userid = ${userId} AND i.type IS DISTINCT FROM 'MONEDA'
      ORDER BY i.ticker
    `;
  }
}
