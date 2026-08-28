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

  async availableCash(
    userId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Prisma.Decimal> {
    const [{ cash }] = await db.$queryRaw<[{ cash: Prisma.Decimal }]>`
      SELECT COALESCE(SUM(
        CASE side
          WHEN 'CASH_IN' THEN size * price
          WHEN 'SELL' THEN size * price
          WHEN 'CASH_OUT' THEN -size * price
          WHEN 'BUY' THEN -size * price
        END
      ), 0) AS cash
      FROM orders
      WHERE userid = ${userId} AND status = 'FILLED'
    `;
    return cash;
  }

  async heldShares(
    userId: number,
    instrumentId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<number> {
    const [{ shares }] = await db.$queryRaw<[{ shares: number }]>`
      SELECT COALESCE(SUM(
        CASE side WHEN 'BUY' THEN size ELSE -size END
      ), 0)::int AS shares
      FROM orders
      WHERE userid = ${userId}
        AND instrumentid = ${instrumentId}
        AND status = 'FILLED'
        AND side IN ('BUY', 'SELL')
    `;
    return shares;
  }

  holdings(
    userId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Holding[]> {
    return db.$queryRaw<Holding[]>`
      WITH net AS (
        SELECT
          o.instrumentid,
          SUM(CASE WHEN o.side = 'BUY' THEN o.size ELSE -o.size END)::int AS quantity,
          SUM(o.size * o.price) FILTER (WHERE o.side = 'BUY')
            / NULLIF(SUM(o.size) FILTER (WHERE o.side = 'BUY'), 0) AS avg_cost
        FROM orders o
        WHERE o.userid = ${userId}
          AND o.status = 'FILLED'
          AND o.side IN ('BUY', 'SELL')
        GROUP BY o.instrumentid
        HAVING SUM(CASE WHEN o.side = 'BUY' THEN o.size ELSE -o.size END) <> 0
      )
      SELECT
        n.instrumentid AS "instrumentId",
        i.ticker,
        i.name,
        n.quantity,
        ROUND(n.quantity * COALESCE(latest.close, 0), 2) AS "marketValue",
        ROUND(n.avg_cost, 2) AS "avgCost",
        CASE WHEN n.quantity > 0 AND n.avg_cost > 0 AND latest.close IS NOT NULL
          THEN ROUND((latest.close - n.avg_cost) / n.avg_cost * 100, 2)
        END AS "totalReturnPct"
      FROM net n
      JOIN instruments i ON i.id = n.instrumentid
      LEFT JOIN LATERAL (
        SELECT m.close
        FROM marketdata m
        WHERE m.instrumentid = n.instrumentid
        -- DESC alone sorts a NULL date first, and an undated row is not the latest close.
        ORDER BY m.date DESC NULLS LAST
        LIMIT 1
      ) latest ON TRUE
      -- Cash is the availableCash line, never a position.
      WHERE i.type IS DISTINCT FROM 'MONEDA'
      ORDER BY i.ticker
    `;
  }
}
