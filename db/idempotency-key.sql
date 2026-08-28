-- The one schema change this service needs, for a database that already exists; db/init.sql
-- carries both statements. Apply to a database you own, never the shared challenge one.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotencyKey TEXT;

-- One row per user and key, so a retried placement cannot become a second order. Partial,
-- so every row already in the table, none of which carries a key, is left alone.
CREATE UNIQUE INDEX IF NOT EXISTS orders_userid_idempotencykey_key
  ON orders (userId, idempotencyKey)
  WHERE idempotencyKey IS NOT NULL;
