import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PortfolioRepository } from '../portfolio/portfolio.repository';
import { PrismaService } from '../prisma/prisma.service';
import {
  decide,
  OrderRuleError,
  OrderStatus,
  OrderType,
  resolveSize,
  Side,
} from './order-rules';
import { PlaceOrderDto } from './place-order.dto';

export type PlacedOrder = {
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

const money = (value?: number): Prisma.Decimal | undefined =>
  value === undefined ? undefined : new Prisma.Decimal(value);

@Injectable()
export class OrdersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly portfolio: PortfolioRepository,
  ) {}

  async place(order: PlaceOrderDto): Promise<PlacedOrder> {
    try {
      return await this.prisma.$transaction((tx) =>
        this.placeWithin(order, tx),
      );
    } catch (error) {
      if (error instanceof OrderRuleError) {
        throw new BadRequestException(error.message);
      }
      throw error;
    }
  }

  private async placeWithin(
    order: PlaceOrderDto,
    tx: Prisma.TransactionClient,
  ): Promise<PlacedOrder> {
    // Serialises a user's placements so two cannot both spend the same balance.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${order.userId})`;

    if (!(await this.portfolio.userExists(order.userId, tx))) {
      throw new NotFoundException(`User ${order.userId} not found`);
    }

    const close = await this.tradableClose(order.instrumentId, tx);
    const limitPrice = money(order.price);
    const size = resolveSize({
      size: order.size,
      amount: money(order.amount),
      price: limitPrice ?? close,
    });

    const { status, price } = decide({
      side: order.side,
      type: order.type,
      price: limitPrice,
      close,
      availableCash: await this.portfolio.availableCash(order.userId, tx),
      heldShares: await this.portfolio.heldShares(
        order.userId,
        order.instrumentId,
        tx,
      ),
      size,
    });

    const datetime = new Date();
    const { id } = await tx.order.create({
      data: {
        userId: order.userId,
        instrumentId: order.instrumentId,
        side: order.side,
        type: order.type,
        size,
        price,
        status,
        datetime,
      },
      select: { id: true },
    });

    return {
      id,
      instrumentId: order.instrumentId,
      userId: order.userId,
      side: order.side,
      size,
      price: price.toFixed(2),
      type: order.type,
      status,
      datetime: datetime.toISOString(),
    };
  }

  private async tradableClose(
    instrumentId: number,
    tx: Prisma.TransactionClient,
  ): Promise<Prisma.Decimal> {
    const [instrument] = await tx.$queryRaw<Quote[]>`
      SELECT i.type, latest.close
      FROM instruments i
      LEFT JOIN LATERAL (
        SELECT m.close
        FROM marketdata m
        WHERE m.instrumentid = i.id
        ORDER BY m.date DESC
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
    return instrument.close;
  }
}
