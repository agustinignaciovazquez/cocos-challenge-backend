import { join } from 'node:path';
import {
  PostgreSqlContainer,
  StartedPostgreSqlContainer,
} from '@testcontainers/postgresql';

const INIT_SQL = join(__dirname, '..', 'db', 'init.sql');

// Postgres runs /docker-entrypoint-initdb.d/*.sql on first boot, before it reports ready,
// so the container the wait strategy hands back is already seeded.
export function startTestDatabase(): Promise<StartedPostgreSqlContainer> {
  return new PostgreSqlContainer('postgres:16')
    .withCopyFilesToContainer([
      { source: INIT_SQL, target: '/docker-entrypoint-initdb.d/init.sql' },
    ])
    .start();
}
