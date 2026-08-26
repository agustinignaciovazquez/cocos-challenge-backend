-- Suggested indexes for the provided schema. Apply to a local database only —
-- never to the shared challenge database (see README, "Base de datos").

-- Every portfolio read and every order placement folds one user's orders.
CREATE INDEX IF NOT EXISTS orders_userid_idx ON orders (userId);

-- Order placement counts the shares one user holds of the one instrument being traded, so
-- the pair is what it filters on; an index on the instrument alone would still read every
-- other user's rows for it.
CREATE INDEX IF NOT EXISTS orders_userid_instrumentid_idx
  ON orders (userId, instrumentId);

-- "Latest close" is a per-instrument top-1 by descending date; this serves it from
-- the index instead of sorting the instrument's history on every quote.
CREATE INDEX IF NOT EXISTS marketdata_instrumentid_date_idx
  ON marketdata (instrumentId, date DESC);
