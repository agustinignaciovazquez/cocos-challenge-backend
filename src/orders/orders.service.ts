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
  resolveSize,
} from './order-rules';
import { OrderRow, OrdersRepository } from './orders.repository';
import { PlaceOrderDto } from './place-order.dto';

export type OrderView = Omit<OrderRow, 'price' | 'datetime'> & {
  price: string;
  datetime: string;
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
    private readonly repository: OrdersRepository,
    // The portfolio folds decide placements so the number that accepts an order is the
    // same number the portfolio displays — duplicating those sums would let them drift.
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
    const cancelled = await this.repository.cancel(id, CANCELLABLE);

    if (cancelled === undefined) {
      const status = await this.repository.statusOf(id);
      if (status === undefined) {
        throw new NotFoundException(`Order ${id} not found`);
      }
      throw new ConflictException(
        `Order ${id} is ${status} and cannot be cancelled`,
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
    await this.repository.lockPlacements(order.userId, tx);

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

    const created = await this.repository.insert(
      {
        instrumentId: order.instrumentId,
        userId: order.userId,
        side: order.side,
        size,
        price,
        type: order.type,
        status,
      },
      tx,
    );

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
    const instrument = await this.repository.quote(instrumentId, tx);

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
