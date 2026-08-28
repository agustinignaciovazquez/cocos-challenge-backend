-- Suggested indexes for the provided schema. Apply to a local database only, never to the
-- shared challenge database (see README, "Base de datos").

-- Superseded by the composite below.
DROP INDEX IF EXISTS orders_userid_idx;
DROP INDEX IF EXISTS orders_instrumentid_idx;

-- Portfolio reads and placements fold one user's orders; placement also counts the shares
-- held of one instrument. The leading column serves the fold, the pair serves the count.
CREATE INDEX IF NOT EXISTS orders_userid_instrumentid_idx
  ON orders (userId, instrumentId);

-- "Latest close" is a per-instrument top-1 by descending date; this serves it from the
-- index instead of sorting the instrument's history on every quote.
CREATE INDEX IF NOT EXISTS marketdata_instrumentid_date_idx
  ON marketdata (instrumentId, date DESC);
