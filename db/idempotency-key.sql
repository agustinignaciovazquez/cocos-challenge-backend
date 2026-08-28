-- The one schema change this service needs, for a database that already exists rather than
-- one built from db/init.sql — where both statements are already part of the table. Apply
-- to a database you own; never to the shared challenge database (see README, "Base de
-- datos"). Both statements are guarded, so applying it twice changes nothing the second
-- time.

ALTER TABLE orders ADD COLUMN IF NOT EXISTS idempotencyKey TEXT;

-- One row per user and key, so a retried placement cannot become a second order. Partial,
-- so every row already in the table — none of which carries a key — is left alone.
CREATE UNIQUE INDEX IF NOT EXISTS orders_userid_idempotencykey_key
  ON orders (userId, idempotencyKey)
  WHERE idempotencyKey IS NOT NULL;
