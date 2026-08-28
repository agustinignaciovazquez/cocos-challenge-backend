import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { startTestDatabase } from './db';

describe('Scaffold (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;

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
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('GET /health returns ok', async () => {
    await request(app.getHttpServer())
      .get('/health')
      .expect(200)
      .expect({ status: 'ok' });
  });

  it('maps the seeded schema onto camelCase Prisma fields', async () => {
    const prisma = app.get(PrismaService);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: 1 } });
    expect(user).toMatchObject({
      email: 'emiliano@test.com',
      accountNumber: '10001',
    });

    const quote = await prisma.marketData.findFirstOrThrow({
      where: { instrumentId: 47 },
      orderBy: { date: 'desc' },
    });
    expect(quote.date?.toISOString()).toBe('2023-07-14T00:00:00.000Z');
    expect(quote.close?.toFixed(2)).toBe('925.85');
    expect(quote.previousClose?.toFixed(2)).toBe('921.80');
  });
});
