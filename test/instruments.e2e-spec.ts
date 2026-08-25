import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { startTestDatabase } from './db';

type InstrumentRow = { id: number; ticker: string; name: string; type: string };

describe('Instruments (e2e)', () => {
  let container: StartedPostgreSqlContainer;
  let app: INestApplication<App>;

  const search = async (q: string): Promise<InstrumentRow[]> => {
    const response = await request(app.getHttpServer())
      .get('/instruments')
      .query({ q })
      .expect(200);
    return response.body as InstrumentRow[];
  };

  const tickers = async (q: string): Promise<string[]> =>
    (await search(q)).map((instrument) => instrument.ticker);

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
  });

  afterAll(async () => {
    await app?.close();
    await container?.stop();
  });

  it('matches a ticker fragment case-insensitively', async () => {
    const pamp = {
      id: 47,
      ticker: 'PAMP',
      name: 'Pampa Holding S.A.',
      type: 'ACCIONES',
    };

    expect(await search('pam')).toEqual([pamp]);
    expect(await search('PAMP')).toEqual([pamp]);
  });

  it('ranks the exact ticker match ahead of the rest', async () => {
    expect(await tickers('irsa')).toEqual(['IRSA', 'IRCP']);
  });

  it('ranks ticker prefixes ahead of the rest, each group alphabetically', async () => {
    expect(await tickers('ir')).toEqual(['IRCP', 'IRSA', 'INTR', 'MIRG']);
  });

  it('matches names too', async () => {
    expect(await tickers('banco')).toEqual(['BBAR', 'BHIP', 'BMA', 'BPAT']);
  });

  it('never returns the MONEDA instrument', async () => {
    expect(await search('ars')).toEqual([]);
    expect(await search('pesos')).toEqual([]);
  });

  it('returns at most 20 rows', async () => {
    expect(await search('a')).toHaveLength(20);
  });

  it('rejects a missing or blank q', async () => {
    await request(app.getHttpServer()).get('/instruments').expect(400);
    await request(app.getHttpServer())
      .get('/instruments')
      .query({ q: '   ' })
      .expect(400);
  });
});
