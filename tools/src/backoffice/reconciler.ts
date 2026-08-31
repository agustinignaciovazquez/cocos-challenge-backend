import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { Pool } from 'pg';
import { DbOrder, LedgerRow } from './anomaly';

const DATABASE_URL =
  process.env.CHALLENGE_DATABASE_URL ??
  'postgresql://postgres:postgres@localhost:5433/cocos';

// `datetime` is `timestamp without time zone` holding UTC, so it is read back as UTC text
// rather than through the driver, which would otherwise reinterpret it in the host's zone.
const FOUND = `id, status, to_char(datetime, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`;

// The order the target stored for one key. Unique per user by a partial index there, so this
// answers at most one row unless that guarantee has broken.
const MATCH_BY_KEY = `
  SELECT ${FOUND}
    FROM orders
   WHERE userid = $1 AND idempotencykey = $2
   ORDER BY id`;

// Everything the invariant checker folds. `price` is NUMERIC(10, 2) and the driver hands
// it back as its exact text, which is what keeps the fold on centavos rather than floats.
const LEDGER = `
  SELECT id, userid AS "userId", instrumentid AS "instrumentId",
         side, size, price::text AS price, type, status
    FROM orders
   WHERE userid = ANY($1::int[])
   ORDER BY id`;

const HIGH_WATER = `SELECT COALESCE(MAX(id), 0)::int AS id FROM orders`;

@Injectable()
export class Reconciler implements OnModuleDestroy {
  // The harness reads the challenge database and never writes to it, so the session itself
  // is read-only: a stray statement fails at the server rather than at review time.
  private readonly pool = new Pool({
    connectionString: DATABASE_URL,
    max: 2,
    options: '-c default_transaction_read_only=on',
  });

  async matchByKey(userId: number, key: string): Promise<DbOrder[]> {
    const { rows } = await this.pool.query<DbOrder>(MATCH_BY_KEY, [
      userId,
      key,
    ]);
    return rows;
  }

  async ledger(userIds: number[]): Promise<LedgerRow[]> {
    const { rows } = await this.pool.query<LedgerRow>(LEDGER, [userIds]);
    return rows;
  }

  // Read before a load run so the rows it created are named by id rather than by clock: a
  // window over `datetime` would have to guess how far the target's own stamp can drift.
  async highWaterMark(): Promise<number> {
    const { rows } = await this.pool.query<{ id: number }>(HIGH_WATER);
    return rows[0].id;
  }

  onModuleDestroy(): Promise<void> {
    return this.pool.end();
  }
}
