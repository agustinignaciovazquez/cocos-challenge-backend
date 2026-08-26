import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { OrderView } from '../src/orders/orders.service';
import { Portfolio } from '../src/portfolio/portfolio.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { startTestDatabase } from './db';

const ARS = 66;
const METR = 54;
const PAMP = 47;
const YPFD = 50;
const OPEN_ORDER = 5;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const diagnosis = (response: request.Response): string =>
  (response.body as { message: string[] }).message[0];

const LOCK_POLL_MS = 50;
// Well under half the placement transaction's 10s timeout, so a lock that never appears
// fails this poll instead of coming back as the 503 that timeout maps to.
const LOCK_POLL_ATTEMPTS = 80;

describe('Orders (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let outsider: PrismaClient;

  const post = (order: object): request.Test =>
    request(app.getHttpServer()).post('/orders').send(order);

  const place = async (order: object): Promise<OrderView> => {
    const response = await post(order).expect(201);
    return response.body as OrderView;
  };

  const portfolio = async (userId: number): Promise<Portfolio> => {
    const response = await request(app.getHttpServer())
      .get(`/users/${userId}/portfolio`)
      .expect(200);
    return response.body as Portfolio;
  };

  const availableCash = async (userId: number): Promise<string> =>
    (await portfolio(userId)).availableCash;

  // Opens a pooled connection per racer up front: against a cold pool the second request
  // queues behind connection setup instead of overlapping the first, which would hide a
  // missing lock rather than expose it.
  const warmPool = (userId: number): Promise<string[]> =>
    Promise.all([availableCash(userId), availableCash(userId)]);

  // A blocked placement is invisible from the API — its query only returns once the lock
  // frees — so the wait is read off pg_locks instead of timed.
  const awaitAdvisoryLock = async (
    userId: number,
    granted: boolean,
  ): Promise<void> => {
    for (let attempt = 0; attempt < LOCK_POLL_ATTEMPTS; attempt++) {
      const [{ locks }] = await prisma.$queryRaw<[{ locks: number }]>`
        SELECT count(*)::int AS locks
        FROM pg_locks
        WHERE locktype = 'advisory' AND granted = ${granted}
          -- The service locks on the single-bigint key: its high half lands in classid and
          -- objsubid is 1, where the two-key form would leave the first key and a 2.
          AND classid = 0 AND objid::bigint = ${userId} AND objsubid = 1
      `;
      if (locks > 0) {
        return;
      }
      await sleep(LOCK_POLL_MS);
    }
    throw new Error(
      `No ${granted ? 'held' : 'waiting'} advisory lock on user ${userId}`,
    );
  };

  beforeAll(async () => {
    container = await startTestDatabase();
    process.env.DATABASE_URL = container.getConnectionUri();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    // One listener for the whole suite: supertest otherwise opens and closes one per
    // request, and a keep-alive socket reused across that close hangs the next request.
    await app.listen(0);
    prisma = app.get(PrismaService);
    outsider = new PrismaClient();
  });

  afterAll(async () => {
    await outsider?.$disconnect();
    await app?.close();
    await container?.stop();
  });

  it('fills a market buy at the latest close', async () => {
    const order = await place({
      userId: 1,
      instrumentId: PAMP,
      side: 'BUY',
      type: 'MARKET',
      size: 10,
    });

    expect(order).toEqual({
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
    // The body is the row read back from the insert, so a timestamp stored in the wrong
    // zone would come back hours away from the placement it reports.
    expect(Math.abs(Date.now() - Date.parse(order.datetime))).toBeLessThan(
      60_000,
    );
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
    const exclusive = await post({
      ...buy,
      type: 'MARKET',
      size: 10,
      amount: 10000,
    }).expect(400);
    await post({ ...buy, type: 'MARKET' }).expect(400);
    const badSize = await post({ ...buy, type: 'MARKET', size: 0 }).expect(400);
    await post({ ...buy, type: 'MARKET', size: -10 }).expect(400);
    await post({ ...buy, type: 'STOP', size: 10 }).expect(400);
    await post({ ...buy, type: 'LIMIT', price: 900.123, size: 10 }).expect(400);
    await post({ ...buy, type: 'MARKET', amount: 100.999 }).expect(400);
    await post({ ...buy, type: 'MARKET', amount: null }).expect(400);
    await post({ ...buy, type: 'MARKET', size: null }).expect(400);
    await post({
      userId: 1,
      instrumentId: PAMP,
      type: 'MARKET',
      size: 10,
    }).expect(400);

    // The two diagnoses are anchored apart on purpose: one message covering both used to
    // answer size: 0 by asking for one of size or amount, which was not the problem.
    expect(diagnosis(exclusive)).toMatch(
      /^send exactly one of size or amount$/,
    );
    expect(diagnosis(badSize)).toMatch(
      /^size must be a whole number of shares/,
    );

    expect(await prisma.order.count()).toBe(before);
  });

  it('rejects ids past the range of the id columns, persisting nothing', async () => {
    const before = await prisma.order.count();
    const buy = { side: 'BUY', type: 'MARKET', size: 10 };
    const tooBig = 9_999_999_999;

    await post({ ...buy, userId: tooBig, instrumentId: PAMP }).expect(400);
    await post({ ...buy, userId: 1, instrumentId: tooBig }).expect(400);

    expect(await prisma.order.count()).toBe(before);
  });

  it('rejects money and sizes the columns cannot hold, persisting nothing', async () => {
    const before = await prisma.order.count();
    const buy = { userId: 1, instrumentId: PAMP, side: 'BUY' };

    await post({ ...buy, type: 'MARKET', size: 9_999_999_999 }).expect(400);
    await post({ ...buy, type: 'MARKET', amount: 1e-7 }).expect(400);
    await post({ ...buy, type: 'MARKET', amount: 1e21 }).expect(400);
    await post({ ...buy, type: 'LIMIT', price: 1e-7, size: 10 }).expect(400);
    await post({ ...buy, type: 'LIMIT', price: 1e21, size: 10 }).expect(400);
    await post({
      ...buy,
      type: 'LIMIT',
      price: 0.01,
      amount: 99999999.99,
    }).expect(400);

    expect(await prisma.order.count()).toBe(before);
  });

  it('answers 400 before 404 when a malformed order names an unknown user', async () => {
    await post({
      userId: 999,
      instrumentId: PAMP,
      side: 'BUY',
      type: 'MARKET',
      size: 10,
      amount: 10000,
    }).expect(400);
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
    await warmPool(2);

    const [first, second] = await Promise.all([place(buy), place(buy)]);

    expect([first.status, second.status].sort()).toEqual([
      'FILLED',
      'REJECTED',
    ]);
    expect(await availableCash(2)).toBe('1370.75');
  });

  it('lets only one of two concurrent sells through the shared position', async () => {
    // 5 PAMP shares cover one 5-share sale at 925.85 but not a second.
    await prisma.$executeRaw`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime)
      VALUES (${ARS}, 3, 100000, 1, 'CASH_IN', 'FILLED', 'MARKET', '2023-07-14 10:00:00'),
             (${PAMP}, 3, 5, 900, 'BUY', 'FILLED', 'MARKET', '2023-07-14 10:01:00')
    `;

    const sell = {
      userId: 3,
      instrumentId: PAMP,
      side: 'SELL',
      type: 'MARKET',
      size: 5,
    };
    await warmPool(3);

    const [first, second] = await Promise.all([place(sell), place(sell)]);

    expect([first.status, second.status].sort()).toEqual([
      'FILLED',
      'REJECTED',
    ]);
    // 100,000 in, 4,500 spent on the shares, 4,629.25 back from the single sale; the
    // position folds to zero and never past it, so no position is left to report.
    expect(await portfolio(3)).toMatchObject({
      availableCash: '100129.25',
      positions: [],
    });
  });

  it('makes a placement wait for the lock holder and read what it spent', async () => {
    await prisma.$executeRaw`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime)
      VALUES (${ARS}, 4, 5000, 1, 'CASH_IN', 'FILLED', 'MARKET', '2023-07-14 10:00:00')
    `;

    let release = (): void => {};
    const held = new Promise<void>((resolve) => {
      release = () => resolve();
    });
    // Holds the placement lock from a connection of its own and spends the balance before
    // committing, so scheduling plays no part: the buy can only reject if it reads the
    // balance after the wait, which is exactly what READ COMMITTED guarantees.
    const holding = outsider.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(4)`;
        await tx.$executeRaw`
          INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime)
          VALUES (${ARS}, 4, 5000, 1, 'CASH_OUT', 'FILLED', 'MARKET', '2023-07-14 10:01:00')
        `;
        await held;
      },
      { timeout: 30_000 },
    );

    let settled = false;
    let placement!: Promise<request.Response>;
    try {
      await awaitAdvisoryLock(4, true);
      placement = post({
        userId: 4,
        instrumentId: PAMP,
        side: 'BUY',
        type: 'MARKET',
        size: 5,
      }).then((response) => {
        settled = true;
        return response;
      });

      await awaitAdvisoryLock(4, false);
      expect(settled).toBe(false);
    } finally {
      // Releasing under finally: a failed poll or assertion would otherwise leave the
      // holder pinning the lock — and the placement queued behind it — for its full 30s.
      release();
    }
    await holding;

    expect((await placement).body).toMatchObject({ status: 'REJECTED' });
  });

  it('settles a cancel beside a placement without moving cash', async () => {
    const before = await availableCash(1);
    await warmPool(1);

    const [cancelled, placed] = await Promise.all([
      request(app.getHttpServer())
        .patch(`/orders/${OPEN_ORDER}/cancel`)
        .expect(200),
      place({
        userId: 1,
        instrumentId: PAMP,
        side: 'BUY',
        type: 'MARKET',
        size: 5,
      }),
    ]);

    expect((cancelled.body as OrderView).status).toBe('CANCELLED');
    expect(placed.status).toBe('FILLED');
    // The buy is the only thing that moved cash: a cancelled NEW order releases nothing
    // because it reserved nothing.
    const spent = new Prisma.Decimal(placed.price).times(placed.size);
    expect(await availableCash(1)).toBe(
      new Prisma.Decimal(before).minus(spent).toFixed(2),
    );
  });
});
