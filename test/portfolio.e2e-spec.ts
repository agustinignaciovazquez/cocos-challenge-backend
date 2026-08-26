import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/configure-app';
import { PrismaService } from '../src/prisma/prisma.service';
import { startTestDatabase } from './db';

describe('Portfolio (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;

  const portfolio = (userId: string): request.Test =>
    request(app.getHttpServer()).get(`/users/${userId}/portfolio`);

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
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('folds the filled orders of a trading user against the latest closes', async () => {
    const response = await portfolio('1').expect(200);

    expect(response.body).toEqual({
      totalValue: '889756.00',
      availableCash: '753000.00',
      positions: [
        {
          instrumentId: 31,
          ticker: 'BMA',
          name: 'Banco Macro S.A.',
          quantity: -10,
          marketValue: '-15028.00',
          avgCost: '1540.00',
          totalReturnPct: null,
        },
        {
          instrumentId: 54,
          ticker: 'METR',
          name: 'MetroGAS S.A.',
          quantity: 500,
          marketValue: '114750.00',
          avgCost: '250.00',
          totalReturnPct: '-8.20',
        },
        {
          instrumentId: 47,
          ticker: 'PAMP',
          name: 'Pampa Holding S.A.',
          quantity: 40,
          marketValue: '37034.00',
          avgCost: '930.00',
          totalReturnPct: '-0.45',
        },
      ],
    });
  });

  it('reports an empty portfolio for a user without orders', async () => {
    const response = await portfolio('2').expect(200);

    expect(response.body).toEqual({
      totalValue: '0.00',
      availableCash: '0.00',
      positions: [],
    });
  });

  it('reports a position with no purchase history without a cost basis', async () => {
    await app.get(PrismaService).$executeRaw`
      INSERT INTO orders (instrumentid, userid, size, price, side, status, type, datetime)
      VALUES (55, 3, 5, 20, 'SELL', 'FILLED', 'MARKET', '2023-07-14 10:00:00')
    `;

    const response = await portfolio('3').expect(200);

    expect(response.body).toEqual({
      totalValue: '5.00',
      availableCash: '100.00',
      positions: [
        {
          instrumentId: 55,
          ticker: 'LONG',
          name: 'Longvie',
          quantity: -5,
          marketValue: '-95.00',
          avgCost: null,
          totalReturnPct: null,
        },
      ],
    });
  });

  it('rejects an unknown user', async () => {
    await portfolio('999').expect(404);
  });

  it('rejects a non-numeric user id', async () => {
    await portfolio('abc').expect(400);
  });

  it('rejects a user id past the range of the id column', async () => {
    await portfolio('9999999999').expect(400);
  });
});
