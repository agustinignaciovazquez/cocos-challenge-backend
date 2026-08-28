import {
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PortfolioRepository } from '../portfolio/portfolio.repository';
import { PrismaService } from '../prisma/prisma.service';
import { OrderRuleError } from './order-rules';
import { OrdersRepository } from './orders.repository';
import { OrdersService } from './orders.service';
import { PlaceOrderDto } from './place-order.dto';

// What the placement transaction throws is mapped outside it, so it is unit-tested here:
// provoking a real P2028 would mean holding the lock past the 10s the service allows, and
// an e2e that sleeps that long buys nothing the stub does not already prove.
const placing = (failure: Error): Promise<unknown> =>
  new OrdersService(
    { $transaction: () => Promise.reject(failure) } as unknown as PrismaService,
    {} as OrdersRepository,
    {} as PortfolioRepository,
  ).place({} as PlaceOrderDto, 'the-transaction-never-runs');

const prismaError = (code: string): Prisma.PrismaClientKnownRequestError =>
  new Prisma.PrismaClientKnownRequestError(code, {
    code,
    clientVersion: Prisma.prismaVersion.client,
  });

describe('place error mapping', () => {
  it('answers 503 when the placement transaction runs out of time', async () => {
    const failed = placing(prismaError('P2028'));

    await expect(failed).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(failed).rejects.toThrow(
      'Order placement timed out waiting its turn, please retry',
    );
  });

  it('answers 400 when a rule turns the order away', async () => {
    await expect(placing(new OrderRuleError('no'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('leaves every other database failure as it is', async () => {
    const write = prismaError('P2002');

    await expect(placing(write)).rejects.toBe(write);
  });
});
