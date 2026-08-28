import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { apiString } from '../money';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, OrderType, Side } from './order-rules';

export type Quote = { type: string | null; close: Prisma.Decimal | null };

export type OrderRow = {
  id: number;
  instrumentId: number;
  userId: number;
  side: Side;
  size: number;
  price: Prisma.Decimal;
  type: OrderType;
  status: OrderStatus;
  datetime: Date;
};

export type NewOrder = Omit<OrderRow, 'id' | 'price' | 'datetime'> & {
  price: bigint;
  // Not `string | null` though the column is: only seeded rows carry no key.
  idempotencyKey: string;
};

// Class half of the placement lock's key: advisory locks share one global space, so a bare
// `userId` is a number anyone could take. The value is the ASCII of 'ORDR'.
export const PLACEMENTS_LOCK = 0x4f524452;

// One projection for every statement here; the aliases undo the schema's lowercasing.
const COLUMNS = Prisma.sql`id, instrumentid AS "instrumentId", userid AS "userId",
                           side, size, price, type, status, datetime`;

@Injectable()
export class OrdersRepository {
  constructor(private readonly prisma: PrismaService) {}

  // No client default: a lock taken outside a transaction is released with its statement.
  // The casts reach the two-key overload, which is declared for a pair of int4s.
  async lockPlacements(
    userId: number,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(${PLACEMENTS_LOCK}::int, ${userId}::int)
    `;
  }

  async quote(
    instrumentId: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<Quote | undefined> {
    const [instrument] = await db.$queryRaw<Quote[]>`
      SELECT i.type, latest.close
      FROM instruments i
      LEFT JOIN LATERAL (
        SELECT m.close
        FROM marketdata m
        WHERE m.instrumentid = i.id
        -- DESC alone sorts a NULL date first, and an undated row is not the latest close.
        ORDER BY m.date DESC NULLS LAST
        LIMIT 1
      ) latest ON TRUE
      WHERE i.id = ${instrumentId}
    `;
    return instrument;
  }

  async insert(
    order: NewOrder,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<OrderRow> {
    const [created] = await db.$queryRaw<OrderRow[]>`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime, idempotencykey)
      -- Money leaves as a two-decimal string; the cast binds it as a number, which the
      -- column needs — it refuses the text a string is otherwise sent as.
      VALUES (${order.instrumentId}, ${order.userId}, ${order.size}, ${apiString(order.price)}::numeric,
              ${order.side}, ${order.status}, ${order.type}, ${new Date()}, ${order.idempotencyKey})
      RETURNING ${COLUMNS}
    `;
    return created;
  }

  async byIdempotencyKey(
    userId: number,
    key: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<OrderRow | undefined> {
    const [replayed] = await db.$queryRaw<OrderRow[]>`
      SELECT ${COLUMNS} FROM orders
      WHERE userid = ${userId} AND idempotencykey = ${key}
    `;
    return replayed;
  }

  async cancel(
    id: number,
    from: OrderStatus[],
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<OrderRow | undefined> {
    const [cancelled] = await db.$queryRaw<OrderRow[]>`
      UPDATE orders
      SET status = 'CANCELLED'
      WHERE id = ${id} AND status IN (${Prisma.join(from)})
      RETURNING ${COLUMNS}
    `;
    return cancelled;
  }

  // `string | null` because the column is nullable and this reads any row, not just the
  // rows this application wrote.
  async statusOf(
    id: number,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string | null | undefined> {
    const order = await db.order.findUnique({
      where: { id },
      select: { status: true },
    });
    return order?.status;
  }
}
