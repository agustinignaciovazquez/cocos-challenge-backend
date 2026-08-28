import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma, PrismaClient } from '@prisma/client';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PLACEMENTS_LOCK } from '../src/orders/orders.repository';
import { OrderView } from '../src/orders/orders.service';
import { Portfolio } from '../src/portfolio/portfolio.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { startTestDatabase } from './db';

const ARS = 66;
const METR = 54;
const PAMP = 47;
const YPFD = 50;
const OPEN_ORDER = 5;

// The one body the idempotency cases send: what they assert is which requests become an
// order, so the order itself stays the same between them and is small enough to repeat.
const ONE_PAMP = {
  userId: 1,
  instrumentId: PAMP,
  side: 'BUY',
  type: 'MARKET',
  size: 1,
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const diagnosis = (response: request.Response): string =>
  (response.body as { message: string[] }).message[0];

// The two 400s are read apart because they arrive in different shapes: the DTO's is the
// array of every rule the body broke, the header's is the one string the handler threw.
const refusal = (response: request.Response): string =>
  (response.body as { message: string }).message;

const LOCK_POLL_MS = 50;
// Well under half the placement transaction's 10s timeout, so a lock that never appears
// fails this poll instead of coming back as the 503 that timeout maps to.
const LOCK_POLL_ATTEMPTS = 80;

describe('Orders (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;
  let prisma: PrismaService;
  let outsider: PrismaClient;

  const unkeyed = (order: object): request.Test =>
    request(app.getHttpServer()).post('/orders').send(order);

  // Every placement below is a logical order of its own, so each carries a key of its own:
  // one key shared between two of them would replay the first instead of placing the
  // second. The cases about replaying name the key they share; this counter answers for
  // the rest, and `unkeyed` is left to the one case that pins a missing header.
  let placements = 0;
  const post = (order: object): request.Test =>
    unkeyed(order).set('Idempotency-Key', `case-${++placements}`);

  const place = async (order: object): Promise<OrderView> => {
    const response = await post(order).expect(201);
    return response.body as OrderView;
  };

  const withKey = (order: object, key: string): request.Test =>
    unkeyed(order).set('Idempotency-Key', key);

  const placeWithKey = async (
    order: object,
    key: string,
    status: number,
  ): Promise<OrderView> => {
    const response = await withKey(order, key).expect(status);
    return response.body as OrderView;
  };

  const rowsFor = (key: string): Promise<number> =>
    prisma.order.count({ where: { idempotencyKey: key } });

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
          -- The repository locks on the two-key form: the class lands in classid, the user
          -- in objid and objsubid is 2, where a single-bigint key would put its own high
          -- half in classid and leave a 1 — so a lock that lost its class matches nothing.
          AND classid::bigint = ${PLACEMENTS_LOCK} AND objid::bigint = ${userId}
          AND objsubid = 2
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
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLACEMENTS_LOCK}::int, 4)`;
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

  it('replays a repeated placement instead of placing it again', async () => {
    const key = 'replay-executes-nothing';
    const placed = await placeWithKey(ONE_PAMP, key, 201);

    expect(await placeWithKey(ONE_PAMP, key, 200)).toEqual(placed);
    expect(await rowsFor(key)).toBe(1);
    // The key identifies the request, not the order, so it is no part of the order the
    // response reports: the body says what the market decided and nothing about the name
    // the request was sent under.
    expect(placed).not.toHaveProperty('idempotencyKey');
  });

  it('holds a key to the order it was first spent on', async () => {
    const key = 'first-write-wins';
    const bought = await placeWithKey(ONE_PAMP, key, 201);

    // A different order under a spent key is still a replay: taking the second body would
    // place an order the caller sent one key for, which is the duplicate this prevents.
    const sell = { ...ONE_PAMP, instrumentId: METR, side: 'SELL', size: 5 };
    expect(await placeWithKey(sell, key, 200)).toEqual(bought);
    expect(await rowsFor(key)).toBe(1);
  });

  it('scopes a key to the user who spent it', async () => {
    const key = 'one-key-two-users';
    const mine = await placeWithKey(ONE_PAMP, key, 201);

    // Keys are the caller's to invent, so two of them will collide eventually. Only the
    // user who spent one can replay it: for anyone else it is a key that was never used.
    const theirs = await placeWithKey({ ...ONE_PAMP, userId: 2 }, key, 201);

    expect(theirs.id).not.toBe(mine.id);
    expect(theirs.userId).toBe(2);
    expect(await rowsFor(key)).toBe(2);
  });

  it('places one order per key', async () => {
    const first = await placeWithKey(ONE_PAMP, 'logical-order-1', 201);
    const second = await placeWithKey(ONE_PAMP, 'logical-order-2', 201);

    expect(second.id).not.toBe(first.id);
  });

  it('turns away a placement sent with no key, persisting nothing', async () => {
    const before = await prisma.order.count();

    // The header is the contract, not an option the caller may decline: an order this
    // service cannot name is one a retry of it cannot be told apart from.
    const refused = await unkeyed(ONE_PAMP).expect(400);

    // Half of a pair: the malformed case below pins the other message, so collapsing the
    // two into one answer fails here rather than passing quietly.
    expect(refusal(refused)).toMatch(/^Idempotency-Key is required/);
    expect(await prisma.order.count()).toBe(before);
  });

  it('settles two concurrent placements sharing a key into one order', async () => {
    const key = 'retried-before-the-answer-arrived';
    await warmPool(1);

    const [first, second] = await Promise.all([
      withKey(ONE_PAMP, key),
      withKey(ONE_PAMP, key),
    ]);

    // The placement lock serialises the pair, so the second one reads the row the first
    // committed: one creation, one replay, and a single order between them.
    expect([first.status, second.status].sort()).toEqual([200, 201]);
    expect((first.body as OrderView).id).toBe((second.body as OrderView).id);
    expect(await rowsFor(key)).toBe(1);
  });

  it('replays a rejected placement as the rejection it recorded', async () => {
    const key = 'a-rejection-is-an-answer';
    const buy = {
      userId: 1,
      instrumentId: YPFD,
      side: 'BUY',
      type: 'MARKET',
      size: 10000,
    };

    const rejected = await placeWithKey(buy, key, 201);
    expect(rejected).toMatchObject({ status: 'REJECTED' });

    expect(await placeWithKey(buy, key, 200)).toEqual(rejected);
    expect(await rowsFor(key)).toBe(1);
  });

  it('refuses a second row under one key at the database itself', async () => {
    const key = 'the-index-is-the-backstop';
    await placeWithKey(ONE_PAMP, key, 201);

    // The lock is what stops the service from trying; the partial unique index is what
    // makes the second row impossible whoever writes it.
    await expect(prisma.$executeRaw`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime, idempotencykey)
      VALUES (${PAMP}, 1, 1, 925.85, 'BUY', 'FILLED', 'MARKET', '2023-07-14 10:00:00', ${key})
    `).rejects.toThrow(/Key \(userid, idempotencykey\)/);

    expect(await rowsFor(key)).toBe(1);
  });

  it('turns away a malformed Idempotency-Key, persisting nothing', async () => {
    const before = await prisma.order.count();

    await withKey(ONE_PAMP, '').expect(400);
    await withKey(ONE_PAMP, 'k'.repeat(65)).expect(400);
    const spaced = await withKey(ONE_PAMP, 'has space').expect(400);
    await withKey(ONE_PAMP, 'a/b').expect(400);

    // The other half of that pair: a key that is present and wrong is answered by the
    // alphabet it broke, not by being asked for a key it already sent.
    expect(refusal(spaced)).toMatch(/^Idempotency-Key must be/);
    expect(await prisma.order.count()).toBe(before);
  });
});
