-- The views the queries read and the indexes they need, for a database that already exists;
-- db/init.sql carries them all. Apply to a database you own, never the shared challenge one.

CREATE OR REPLACE VIEW cash_balances AS
SELECT
  userId,
  SUM(
    CASE side
      WHEN 'CASH_IN' THEN size * price
      WHEN 'SELL' THEN size * price
      WHEN 'CASH_OUT' THEN -size * price
      WHEN 'BUY' THEN -size * price
    END
  ) AS cash
FROM orders
WHERE status = 'FILLED'
GROUP BY userId;

-- A net of zero is no position; a negative one is reported as it stands. SUM widens to
-- bigint, and the client reads that as a BigInt, so the cast is load-bearing.
CREATE OR REPLACE VIEW holdings AS
SELECT
  userId,
  instrumentId,
  SUM(CASE WHEN side = 'BUY' THEN size ELSE -size END)::int AS quantity,
  SUM(size * price) FILTER (WHERE side = 'BUY')
    / NULLIF(SUM(size) FILTER (WHERE side = 'BUY'), 0) AS avg_cost
FROM orders
WHERE status = 'FILLED' AND side IN ('BUY', 'SELL')
GROUP BY userId, instrumentId
HAVING SUM(CASE WHEN side = 'BUY' THEN size ELSE -size END) <> 0;

-- DESC alone sorts a NULL date first, and an undated row is not the latest close.
CREATE OR REPLACE VIEW latest_closes AS
SELECT DISTINCT ON (instrumentId) instrumentId, close
FROM marketdata
ORDER BY instrumentId, date DESC NULLS LAST;

-- Superseded by the partial covering index below.
DROP INDEX IF EXISTS orders_userid_idx;
DROP INDEX IF EXISTS orders_instrumentid_idx;
DROP INDEX IF EXISTS orders_userid_instrumentid_idx;

-- The folds read filled rows only and read nothing this index does not carry, so they are
-- answered without touching the table at all.
CREATE INDEX IF NOT EXISTS orders_filled_userid_instrumentid_side_idx
  ON orders (userId, instrumentId, side) INCLUDE (size, price)
  WHERE status = 'FILLED';

-- "Latest close" is a per-instrument top-1 by descending date. The planner scans the
-- 126-row seed instead; this serves the top-1 once real market data arrives.
CREATE INDEX IF NOT EXISTS marketdata_instrumentid_date_idx
  ON marketdata (instrumentId, date DESC);
