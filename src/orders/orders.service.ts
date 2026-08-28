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

// `replayed` is for the controller, not the order: a replay answers 200, not 201.
export type Placed = { order: OrderView; replayed: boolean };

const CANCELLABLE = ORDER_STATUSES.filter((status) =>
  canTransition(status, 'CANCELLED'),
);

const centavos = (value?: number): bigint | undefined =>
  value === undefined ? undefined : centavosFromApi(value);

const view = (order: OrderRow): OrderView => ({
  ...order,
  price: apiString(centavosFromDb(order.price)),
  datetime: order.datetime.toISOString(),
});

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly repository: OrdersRepository,
    // Placement uses the portfolio folds so the number that accepts an order and the
    // number the portfolio displays cannot drift.
    private readonly portfolio: PortfolioRepository,
  ) {}

  async place(order: PlaceOrderDto, key: string): Promise<Placed> {
    try {
      return await this.prisma.$transaction(
        (tx) => this.placeWithin(order, key, tx),
        {
          isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
          // Both bound queueing, not work: the placement is half a dozen indexed
          // statements, so running out means load, not a slow query.
          maxWait: 5_000,
          timeout: 10_000,
        },
      );
    } catch (error) {
      if (error instanceof OrderRuleError) {
        throw new BadRequestException(error.message);
      }
      // P2028 is one of those two waits giving up: busy, not broken, safe to send again.
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
    // No lock: the transition is the UPDATE's own condition and placement only inserts.
    // If NEW orders ever reserve funds, cancel must take the placement lock too.
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

    return view(cancelled);
  }

  private async placeWithin(
    order: PlaceOrderDto,
    key: string,
    tx: Prisma.TransactionClient,
  ): Promise<Placed> {
    // Serialises a user's placements so two cannot spend the same balance. Only correct
    // under READ COMMITTED: a repeatable-read snapshot predates the wait.
    await this.repository.lockPlacements(order.userId, tx);

    // Under the lock a key that misses here is still free at the insert; the index is the
    // backstop, uncaught on purpose — a 500 beats papering over a lock that stopped working.
    const replayed = await this.repository.byIdempotencyKey(
      order.userId,
      key,
      tx,
    );
    if (replayed !== undefined) {
      return { order: view(replayed), replayed: true };
    }

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
        idempotencyKey: key,
      },
      tx,
    );

    return { order: view(created), replayed: false };
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
