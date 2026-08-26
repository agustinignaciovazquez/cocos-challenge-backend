import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { apiString, centavosFromApi, centavosFromDb } from '../money';
import { PortfolioRepository } from '../portfolio/portfolio.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  canTransition,
  decide,
  OrderRuleError,
  ORDER_STATUSES,
  OrderStatus,
  OrderType,
  resolveSize,
  Side,
} from './order-rules';
import { PlaceOrderDto } from './place-order.dto';

export type OrderView = {
  id: number;
  instrumentId: number;
  userId: number;
  side: Side;
  size: number;
  price: string;
  type: OrderType;
  status: OrderStatus;
  datetime: string;
};

type Quote = { type: string | null; close: Prisma.Decimal | null };

type OrderRow = Omit<OrderView, 'price' | 'datetime'> & {
  price: Prisma.Decimal;
  datetime: Date;
};

const CANCELLABLE = ORDER_STATUSES.filter((status) =>
  canTransition(status, 'CANCELLED'),
);

const centavos = (value?: number): bigint | undefined =>
  value === undefined ? undefined : centavosFromApi(value);

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioRepository,
  ) {}

  async place(order: PlaceOrderDto): Promise<OrderView> {
    try {
      return await this.prisma.$transaction(
        (tx) => this.placeWithin(order, tx),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          // Both bound queueing, not work: the placement is half a dozen indexed
          // statements, so 5s waiting for a connection or 10s inside the advisory-lock
          // queue means load, not a slow query.
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      if (error instanceof OrderRuleError) {
        throw new BadRequestException(error.message);
      }
      // P2028 is the transaction giving up on one of those two waits: the server is busy,
      // not broken, and the caller's own order is intact to send again.
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2028'
      ) {
        throw new ServiceUnavailableException(
          'Order placement timed out waiting its turn, please retry',
        );
      }
      throw error;
    }
  }

  async cancel(id: number): Promise<OrderView> {
    // The transition is the UPDATE's own condition, so concurrent cancels cannot both
    // match the row and no lock is needed: placement only ever inserts. Should NEW orders
    // ever reserve funds, cancel starts moving a balance and must take the same advisory
    // lock placement holds.
    const [cancelled] = await this.prisma.$queryRaw<OrderRow[]>`
      UPDATE orders
      SET status = 'CANCELLED'
      WHERE id = ${id} AND status IN (${Prisma.join(CANCELLABLE)})
      RETURNING id, instrumentid AS "instrumentId", userid AS "userId",
                side, size, price, type, status, datetime
    `;

    if (cancelled === undefined) {
      const order = await this.prisma.order.findUnique({
        where: { id },
        select: { status: true },
      });
      if (order === null) {
        throw new NotFoundException(`Order ${id} not found`);
      }
      throw new ConflictException(
        `Order ${id} is ${order.status} and cannot be cancelled`,
      );
    }

    return {
      ...cancelled,
      price: apiString(centavosFromDb(cancelled.price)),
      datetime: cancelled.datetime.toISOString(),
    };
  }

  private async placeWithin(
    order: PlaceOrderDto,
    tx: Prisma.TransactionClient,
  ): Promise<OrderView> {
    // Serialises a user's placements so two cannot both spend the same balance — which
    // holds only under READ COMMITTED, where the balance is read after the wait: a
    // repeatable-read snapshot predates the wait and would still show it unspent.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${order.userId})`;

    if (!(await this.portfolio.userExists(order.userId, tx))) {
      throw new NotFoundException(`User ${order.userId} not found`);
    }

    const close = await this.tradableClose(order.instrumentId, tx);
    const limitPrice = centavos(order.price);
    const size = resolveSize({
      size: order.size,
      amount: centavos(order.amount),
      price: limitPrice ?? close,
    });

    const { status, price } = decide({
      side: order.side,
      type: order.type,
      price: limitPrice,
      close,
      availableCash: centavosFromDb(
        await this.portfolio.availableCash(order.userId, tx),
      ),
      heldShares: await this.portfolio.heldShares(
        order.userId,
        order.instrumentId,
        tx,
      ),
      size,
    });

    const [created] = await tx.$queryRaw<OrderRow[]>`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime)
      -- Money leaves the application as its two-decimal string, and the cast is what binds
      -- that as a number: the column refuses the text a string is otherwise sent as.
      VALUES (${order.instrumentId}, ${order.userId}, ${size}, ${apiString(price)}::numeric,
              ${order.side}, ${status}, ${order.type}, ${new Date()})
      RETURNING id, instrumentid AS "instrumentId", userid AS "userId",
                side, size, price, type, status, datetime
    `;

    return {
      ...created,
      price: apiString(centavosFromDb(created.price)),
      datetime: created.datetime.toISOString(),
    };
  }

  private async tradableClose(
    instrumentId: number,
    tx: Prisma.TransactionClient,
  ): Promise<bigint> {
    const [instrument] = await tx.$queryRaw<Quote[]>`
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

    if (instrument === undefined) {
      throw new NotFoundException(`Instrument ${instrumentId} not found`);
    }
    if (instrument.type === 'MONEDA') {
      throw new BadRequestException(
        `Instrument ${instrumentId} is a currency and cannot be traded`,
      );
    }
    if (instrument.close === null) {
      throw new BadRequestException(
        `Instrument ${instrumentId} has no market data`,
      );
    }
    return centavosFromDb(instrument.close);
  }
}
