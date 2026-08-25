import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { OrderView } from '../src/orders/orders.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { startTestDatabase } from './db';

const ARS = 66;
const METR = 54;
const PAMP = 47;
const YPFD = 50;

describe('Orders (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const post = (order: object): request.Test =>
    request(app.getHttpServer()).post('/orders').send(order);

  const place = async (order: object): Promise<OrderView> => {
    const response = await post(order).expect(201);
    return response.body as OrderView;
  };

  const availableCash = async (userId: number): Promise<string> => {
    const response = await request(app.getHttpServer())
      .get(`/users/${userId}/portfolio`)
      .expect(200);
    return (response.body as { availableCash: string }).availableCash;
  };

  beforeAll(async () => {
    container = await startTestDatabase();
    process.env.DATABASE_URL = container.getConnectionUri();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
    // One listener for the whole suite: supertest otherwise opens and closes one per
    // request, and a keep-alive socket reused across that close hangs the next request.
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('fills a market buy at the latest close', async () => {
    expect(
      await place({
        userId: 1,
        instrumentId: PAMP,
        side: 'BUY',
        type: 'MARKET',
        size: 10,
      }),
    ).toEqual({
      id: expect.any(Number) as number,
      instrumentId: PAMP,
      userId: 1,
      side: 'BUY',
      size: 10,
      price: '925.85',
      type: 'MARKET',
      status: 'FILLED',
      datetime: expect.any(String) as string,
    });
  });

  it('parks a limit buy at its limit price', async () => {
    expect(
      await place({
        userId: 1,
        instrumentId: PAMP,
        side: 'BUY',
        type: 'LIMIT',
        price: 900,
        size: 10,
      }),
    ).toMatchObject({ status: 'NEW', price: '900.00', size: 10 });
  });

  it('rejects a buy the available cash cannot cover', async () => {
    expect(
      await place({
        userId: 1,
        instrumentId: YPFD,
        side: 'BUY',
        type: 'MARKET',
        size: 10000,
      }),
    ).toMatchObject({ status: 'REJECTED', price: '7837.50', size: 10000 });
  });

  it('leaves the available cash untouched when an order is rejected', async () => {
    const before = await availableCash(1);

    expect(
      await place({
        userId: 1,
        instrumentId: YPFD,
        side: 'BUY',
        type: 'MARKET',
        size: 10000,
      }),
    ).toMatchObject({ status: 'REJECTED' });

    expect(await availableCash(1)).toBe(before);
  });

  it('rejects a sell beyond the held shares', async () => {
    expect(
      await place({
        userId: 1,
        instrumentId: METR,
        side: 'SELL',
        type: 'MARKET',
        size: 999,
      }),
    ).toMatchObject({ status: 'REJECTED', price: '229.50' });
  });

  it('fills a sell covered by the held shares', async () => {
    expect(
      await place({
        userId: 1,
        instrumentId: METR,
        side: 'SELL',
        type: 'MARKET',
        size: 100,
      }),
    ).toMatchObject({ status: 'FILLED', price: '229.50', size: 100 });
  });

  it('turns an amount into whole shares at the execution price', async () => {
    expect(
      await place({
        userId: 1,
        instrumentId: PAMP,
        side: 'BUY',
        type: 'MARKET',
        amount: 10000,
      }),
    ).toMatchObject({ status: 'FILLED', price: '925.85', size: 10 });
  });

  it('rejects an amount that does not reach one share, persisting nothing', async () => {
    const before = await prisma.order.count();

    await post({
      userId: 1,
      instrumentId: PAMP,
      side: 'BUY',
      type: 'MARKET',
      amount: 100,
    }).expect(400);

    expect(await prisma.order.count()).toBe(before);
  });

  it('rejects a malformed request, persisting nothing', async () => {
    const before = await prisma.order.count();
    const buy = { userId: 1, instrumentId: PAMP, side: 'BUY' };

    await post({ ...buy, type: 'LIMIT', size: 10 }).expect(400);
    await post({ ...buy, type: 'MARKET', price: 900, size: 10 }).expect(400);
    await post({ ...buy, type: 'MARKET', size: 10, amount: 10000 }).expect(400);
    await post({ ...buy, type: 'MARKET' }).expect(400);
    await post({ ...buy, type: 'MARKET', size: 0 }).expect(400);
    await post({ ...buy, type: 'MARKET', size: -10 }).expect(400);
    await post({ ...buy, type: 'STOP', size: 10 }).expect(400);
    await post({ ...buy, type: 'LIMIT', price: 900.123, size: 10 }).expect(400);
    await post({ ...buy, type: 'MARKET', amount: 100.999 }).expect(400);
    await post({
      userId: 1,
      instrumentId: PAMP,
      type: 'MARKET',
      size: 10,
    }).expect(400);

    expect(await prisma.order.count()).toBe(before);
  });

  it('rejects an unknown user or instrument, and the currency itself', async () => {
    const buy = { side: 'BUY', type: 'MARKET', size: 10 };

    await post({ ...buy, userId: 999, instrumentId: PAMP }).expect(404);
    await post({ ...buy, userId: 1, instrumentId: 9999 }).expect(404);
    await post({ ...buy, userId: 1, instrumentId: ARS }).expect(400);
  });

  it('lets only one of two concurrent buys through the shared balance', async () => {
    // 6,000 pesos covers one 5-share PAMP buy at 925.85 (4,629.25) but not a second.
    await prisma.$executeRaw`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime)
      VALUES (${ARS}, 2, 6000, 1, 'CASH_IN', 'FILLED', 'MARKET', '2023-07-14 10:00:00')
    `;

    const buy = {
      userId: 2,
      instrumentId: PAMP,
      side: 'BUY',
      type: 'MARKET',
      size: 5,
    };
    // Opens a pooled connection for each buy up front: against a cold pool the second
    // placement queues behind connection setup instead of overlapping the first, which
    // would hide a missing lock rather than expose it.
    await Promise.all([availableCash(2), availableCash(2)]);

    const [first, second] = await Promise.all([place(buy), place(buy)]);

    expect([first.status, second.status].sort()).toEqual([
      'FILLED',
      'REJECTED',
    ]);
    expect(await availableCash(2)).toBe('1370.75');
  });
});
