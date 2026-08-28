import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { startTestDatabase } from './db';

const OPEN = 5;
const ANOTHER_OPEN = 7;
const FILLED = 2;
const CANCELLED = 3;
const REJECTED = 6;

describe('Order cancellation (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;
  let prisma: PrismaService;

  const cancel = (id: number | string): request.Test =>
    request(app.getHttpServer()).patch(`/orders/${id}/cancel`);

  const statusOf = async (id: number): Promise<string | null | undefined> =>
    (await prisma.order.findUnique({ where: { id }, select: { status: true } }))
      ?.status;

  beforeAll(async () => {
    container = await startTestDatabase();
    process.env.DATABASE_URL = container.getConnectionUri();

    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleRef.createNestApplication();
    configureApp(app);
    await app.init();
    // One listener for the whole suite: supertest otherwise opens one per request, and a keep-alive socket reused across that close hangs the next.
    await app.listen(0);
    prisma = app.get(PrismaService);
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('cancels an open order and returns it', async () => {
    const response = await cancel(OPEN).expect(200);

    expect(response.body).toEqual({
      id: OPEN,
      instrumentId: 45,
      userId: 1,
      side: 'BUY',
      size: 50,
      price: '710.00',
      type: 'LIMIT',
      status: 'CANCELLED',
      datetime: '2023-07-12T15:14:20.000Z',
    });
    expect(await statusOf(OPEN)).toBe('CANCELLED');
  });

  it('refuses to cancel an order that is not open, leaving it as it was', async () => {
    for (const id of [FILLED, CANCELLED, REJECTED]) {
      const before = await statusOf(id);

      await cancel(id).expect(409);

      expect(await statusOf(id)).toBe(before);
    }
  });

  it('answers 404 for an order that does not exist', async () => {
    await cancel(9999).expect(404);
  });

  it('rejects an id that is not a number', async () => {
    await cancel('abc').expect(400);
  });

  it('rejects an id past the range of the id column', async () => {
    await cancel('9999999999').expect(400);
  });

  it('lets only one of two concurrent cancels through', async () => {
    // A pooled connection per cancel up front: against a cold pool the second request
    // queues behind connection setup and would hide a read-then-write race.
    await Promise.all([cancel(9999).expect(404), cancel(9999).expect(404)]);

    const [first, second] = await Promise.all([
      cancel(ANOTHER_OPEN),
      cancel(ANOTHER_OPEN),
    ]);

    expect([first.status, second.status].sort()).toEqual([200, 409]);
    expect(await statusOf(ANOTHER_OPEN)).toBe('CANCELLED');
  });
});
