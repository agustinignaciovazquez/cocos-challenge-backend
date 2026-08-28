# Cocos — Backend Challenge

A trading API over the database the challenge provides: a user's **portfolio**, a
**search** over the instruments of the market, and **sending an order** (MARKET or LIMIT,
BUY or SELL) — plus cancelling an open one.

Node 22 · NestJS 11 · TypeScript strict · Prisma · PostgreSQL 16 · Jest + supertest +
testcontainers.

---

## Quickstart

```bash
npm install                 # postinstall runs `prisma generate`
cp .env.example .env        # DATABASE_URL for the compose database below
docker compose up -d --wait # Postgres 16 on :5433, seeded from db/init.sql on first boot
npm run start:dev           # http://localhost:3000
```

Compose seeds the database, so there is no migration step and nothing to import by hand;
`--wait` holds until the healthcheck passes, so the dev server never opens a pool against a
database still seeding. `docker compose down -v` discards the data, and the next `up`
reseeds from `db/init.sql`.

To run against the challenge's hosted database instead, point `DATABASE_URL` at it
(`.env.example` carries the commented line) and apply
[`db/idempotency-key.sql`](db/idempotency-key.sql) to it first, or **every** placement
fails on the missing column — see [Base de datos](#base-de-datos).

- Interactive docs: <http://localhost:3000/docs> (OpenAPI JSON at `/docs-json`)
- Ready-to-send calls: [`requests.http`](requests.http) — 40 cases, every endpoint with
  its happy and failure paths, for the VS Code REST Client extension

`npm run start:prod` serves the compiled build; `PORT` overrides the port.

### Tests

```bash
npm test         # 38 unit + 49 e2e
npm run test:unit
npm run test:e2e # needs a running Docker daemon
```

Unit tests cover the money conversions at their boundaries, the pure order rules (sizing,
the accept/reject decision, the status transitions), the `Idempotency-Key` every placement
must carry and the alphabet it is held to, and the HTTP status each placement failure maps
to. DB-backed tests run against a throwaway Postgres 16 that `@testcontainers/postgresql`
starts and seeds from `db/init.sql`; no test touches a shared database. Six pin
concurrency: simultaneous buys on one balance, simultaneous sells on one position,
simultaneous cancels of one order, a placement blocked behind a held advisory lock, a
cancel beside a placement, and a retried placement beside the one it repeats.

`npm run lint` runs Prettier in check mode and then ESLint. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs `npm ci`, lint, build and the
full test suite on every push and pull request.

---

## API

| Method  | Path                   | What it does                                     |
| ------- | ---------------------- | ------------------------------------------------ |
| `GET`   | `/health`              | Liveness probe                                   |
| `GET`   | `/instruments?q=`      | Search by ticker or name, up to 20 rows          |
| `GET`   | `/users/:id/portfolio` | Total value, pesos available to trade, positions |
| `POST`  | `/orders`              | Send a BUY/SELL, MARKET/LIMIT order              |
| `PATCH` | `/orders/:id/cancel`   | Cancel an order that is still `NEW`              |

Errors use Nest's default shape (`{ statusCode, error, message }`). Money is always a
string with two decimals.

**`GET /users/1/portfolio`**

```json
{
  "totalValue": "889756.00",
  "availableCash": "753000.00",
  "positions": [
    {
      "instrumentId": 31,
      "ticker": "BMA",
      "name": "Banco Macro S.A.",
      "quantity": -10,
      "marketValue": "-15028.00",
      "avgCost": "1540.00",
      "totalReturnPct": null
    },
    {
      "instrumentId": 54,
      "ticker": "METR",
      "name": "MetroGAS S.A.",
      "quantity": 500,
      "marketValue": "114750.00",
      "avgCost": "250.00",
      "totalReturnPct": "-8.20"
    },
    {
      "instrumentId": 47,
      "ticker": "PAMP",
      "name": "Pampa Holding S.A.",
      "quantity": 40,
      "marketValue": "37034.00",
      "avgCost": "930.00",
      "totalReturnPct": "-0.45"
    }
  ]
}
```

`totalValue` is the cash plus every position at its latest close — 753000 + 37034 +
114750 − 15028 = 889756. The short BMA line is [the seed's own arithmetic, reported rather
than hidden](#the-seeds-10-bma-position-is-reported-honestly).

**`POST /orders`** — `size` **or** `amount` (pesos), never both:

```json
{ "userId": 1, "instrumentId": 47, "side": "BUY", "type": "MARKET", "size": 10 }
```

```json
{
  "id": 12,
  "instrumentId": 47,
  "userId": 1,
  "side": "BUY",
  "size": 10,
  "price": "925.85",
  "type": "MARKET",
  "status": "FILLED",
  "datetime": "2026-08-25T21:57:29.563Z"
}
```

`POST /orders` requires an `Idempotency-Key` header — 1–64 characters of `[A-Za-z0-9_-]`,
naming the logical order rather than the attempt. The same key again returns the same order
with a **200** instead of a 201, having executed nothing a second time; no key is a **400**
with nothing placed — [why it is required rather than
offered](#an-idempotency-key-turns-a-retried-placement-into-one-order).

---

## Decisiones y supuestos

### Balances fold `FILLED` orders only — a `NEW` order reserves nothing

The challenge asks for the tenencia and the pesos disponibles from the movements in
`orders`, using the `FILLED` rows for each position. So `availableCash` is
`CASH_IN + SELL proceeds − CASH_OUT − BUY cost` over that user's `FILLED` orders, and each
position is `BUY − SELL` sizes of one instrument.

The consequence is deliberate: an open limit order holds no money, so a user with 100.000
pesos can leave two open limit buys of 100.000 each — both passed the check when they were
sent, and neither has spent anything. The alternative, reserving the funds (or shares) when
an order is accepted and releasing them on fill or cancel, needs a balance the API owns
rather than one derived from the order log; I left it out because that changes the data
model the challenge handed me. It is the first item under [what I'd do
next](#what-id-do-next).

### Total return is measured against the position's cost basis

`totalReturnPct = (latestClose − avgCost) / avgCost × 100`, rounded to two decimals, with
`avgCost` the size-weighted average price of that instrument's `FILLED` BUYs
(`Σ size·price / Σ size`). Sells reduce the quantity, not the average: average-cost rather
than FIFO, the convention a broker statement uses for _rendimiento total_. It is `null`
where the number would mean nothing — a negative (short) position, where the ratio's sign
flips; a position with no purchase to give it a cost basis; an instrument with no market
data.

The challenge also mentions `close` and `previousClose`: that pair is the instrument's
_daily_ return, a different figure from the position's total return. I compute the total
return; the daily one is a one-line addition to the same query if it is wanted.

### MARKET executes at the latest close; LIMIT parks at its price

There is no market to simulate, so a MARKET order fills immediately at the `close` of the
most recent `marketdata` row for that instrument (the `latest_closes` view; the seed
carries two days of prices for every instrument that has any, so the ordering matters). Two
seeded equities carry no prices at all: an order for either is a 400 rather than a fill at
an invented price.

A LIMIT order is persisted as `NEW` at the price the user sent and stays there until it is
cancelled — nothing here crosses it against a later price.

### A `REJECTED` order is a 201, not a 4xx

If the pesos do not cover a buy, or the shares do not cover a sell, the order is persisted
`REJECTED` and returned with **201**: the request succeeded, and the market's verdict is
the payload for a client that reads the status. That row is what the challenge asks to
record, and a 4xx would say the request was malformed, which it was not.

4xx keeps its meaning: **400** malformed or unfulfillable input, **404** unknown user,
instrument or order, **409** an order whose status forbids the transition. The one 5xx is
not a bug: **503** when a placement never gets its turn behind the [advisory
lock](#concurrency-one-advisory-lock-for-placement-a-conditional-update-for-cancellation),
retryable under the same
[`Idempotency-Key`](#an-idempotency-key-turns-a-retried-placement-into-one-order).

### Concurrency: one advisory lock for placement, a conditional UPDATE for cancellation

Placement reads a balance and then writes an order that depends on it, so the two must not
interleave. The placement runs in one transaction opening with
`SELECT pg_advisory_xact_lock(PLACEMENTS_LOCK, userId)`: a user's orders are serialised,
different users never contend, and the lock is released with the transaction, so a dead
request leaves nothing to clean up. The first argument is a class of this application's
own, because Postgres keeps every advisory lock in one global space where a bare `userId`
is a number any other component can take. Two simultaneous buys on one balance — or two
sells on one position — therefore produce one `FILLED` and one `REJECTED`, which the e2e
suite asserts.

The transaction is pinned to `READ COMMITTED`, which is what makes the lock mean anything:
the balance has to be read after the wait, and a repeatable-read snapshot would predate it
and still show the cash the holder just spent. An e2e test holds the lock from a second
connection, spends the balance there, and asserts the blocked placement wakes up
`REJECTED`.

The budget — 5s for a connection, 10s to run — bounds queueing rather than work: the
placement is half a dozen indexed statements. When either runs out Prisma raises `P2028`,
answered **503** rather than 500: a placement that never got its turn is a load condition,
and the caller's order is intact to resend — safely, because whether the shed request
reached the database or not, its [`Idempotency-Key`](#an-idempotency-key-turns-a-retried-placement-into-one-order)
settles the pair into one order. The created row is read back from the
`INSERT … RETURNING`, so the response reports what Postgres stored, not a reconstruction of
what was sent.

Alternatives I did not take: `SERIALIZABLE` is correct but turns a preventable conflict
into a serialization failure every caller has to retry; an optimistic version column needs
a balance row to version, and my balance is derived from the order log.

Cancellation needs no lock. The transition _is_ the UPDATE's predicate —
`UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND status IN ('NEW') RETURNING …` —
so of two concurrent cancels only one matches a row, and the other reads back the current
status to answer 409. Placement only INSERTs, so it cannot race with a cancel, and
cancelling moves no cash because a `NEW` order reserved none — the day reservation lands,
cancel becomes balance-mutating and takes the same lock.

### An `Idempotency-Key` turns a retried placement into one order

A chaos run against this API — one response in five dropped, a client that retried every
one of them — turned 43 logical orders into 86 rows in 65 seconds. 28 of those pairs filled
on **both** legs: **ARS 34,395.65** of notional executed twice, money that moved only
because a retry was indistinguishable from a second order. Nothing bounded the damage but
the balance: one retry was refused by ARS 2.10, and a richer account would have been _less_
protected. Nothing else in that run broke — the advisory lock serialised every placement,
the rules never disagreed with an independent centavo fold, and atomicity across an
8-second database freeze was exact — so this is the one defect that needed a code change,
and the only reason I touched the schema.

`POST /orders` now requires an `Idempotency-Key`: 1–64 characters of `[A-Za-z0-9_-]`,
anything else a 400. It names the _logical_ order rather than the attempt, so a client
generates it once and resends it verbatim on every retry — a key regenerated per HTTP
attempt buys nothing. The first request under a key places the order and answers 201; every
later one answers **200** with the stored row and executes nothing a second time: same id,
status and price. A `REJECTED` row replays as the rejection it recorded rather than being
decided again: the balance may have moved since.

**Required, not offered** — a deliberate break with the endpoint the challenge specifies. A
safety the caller may decline is not a guarantee: the client that skips the header is the
one whose retry places the order twice, and the 43 above sent no key because there was none
to send. A placement that does not name itself is therefore a **400** with nothing
persisted, and the two mistakes get their own message, since they are the caller's to tell
apart: no key at all, or a key outside the alphabet. The cost is one identifier per logical
order; the cost of leaving it optional is the number this section opens with.

The lookup runs inside the placement transaction, right after the lock and before anything
is decided, which is what makes it race-free: a user's placements are already serialised,
so between a key missing and that key being written no other placement of that user's can
run. Two simultaneous requests sharing a key produce one 201, one 200, one row — which the
e2e suite asserts. The unique index is the backstop, not the mechanism, and its `23505` is
left uncaught on purpose: reaching one would mean the lock had stopped serialising, and a
500 says so where a silent re-read would hide it.

The schema change is `orders.idempotencyKey TEXT` plus
`CREATE UNIQUE INDEX … ON orders (userId, idempotencyKey) WHERE idempotencyKey IS NOT NULL`,
in [`db/init.sql`](db/init.sql) for a database built from it and in
[`db/idempotency-key.sql`](db/idempotency-key.sql) for one that already exists. Partial, so
the 11 seeded rows that carry no key — written before there was a header to send — are
untouched, and the column stays nullable for exactly those. The Prisma model maps the
column and nothing more — a Prisma `@@unique` cannot carry the `WHERE` that keeps unkeyed
rows out of it.

One case is settled rather than solved: a key that comes back with a _different_ order gets
the stored row anyway, which is the safer of the two wrong answers because it executes
nothing. The production answer is [409](#what-id-do-next).

### The seed's −10 BMA position is reported honestly

User 1 sold 30 BMA against 20 bought, so the fold yields quantity −10, marketValue
−15028.00 and `totalReturnPct: null`. I did not clamp it to zero or hide it: the data says
the account is short, and hiding it would leave the endpoint disagreeing with the ledger.
New orders cannot deepen it — a sell beyond the held shares is `REJECTED`.

### A position in an instrument with no market data is valued at 0

`marketValue` is `ROUND(quantity × COALESCE(c.close, 0), 2)` over `latest_closes`, so a
holding of an instrument with no `marketdata` row — PGR and IRCP in the seed — is listed
with its quantity and the cost basis its buys give it, a `marketValue` of `0.00` and a
`null` total return, contributing nothing to `totalValue`. Nothing this service does can
create such a holding: the missing price is the same one that turns an order for either into
[a 400](#market-executes-at-the-latest-close-limit-parks-at-its-price), so the case only
arrives with data loaded from outside the API.

The alternative — dropping those lines from `totalValue`, or reporting the value as `null`,
which says "price unknown" rather than implying "worth nothing" — I did not take: excluding
the line gives a total that no longer equals the sum of the positions above it, `null`
changes the type of a money field, and neither is worth a contract change for a case the
seed never reaches. It is the reading the [−10 BMA
line](#the-seeds-10-bma-position-is-reported-honestly) already gets: the ledger as it
stands, the position visible rather than dropped, only its price missing.

### Cash is the `MONEDA` instrument; `CASH_IN`/`CASH_OUT` are data, not an endpoint

ARS is instrument 66, type `MONEDA`, and transfers are `orders` rows with `price = 1` and
`size` in pesos. Both sides are folded into `availableCash`, so the seeded transfers count.
`MONEDA` is excluded from search results and from the positions list (it _is_ the
`availableCash` line), and it cannot be traded: `POST /orders` for it answers 400.

`POST /orders` accepts `BUY` and `SELL` only. A deposit is not an order sent to the market
but the settlement of an external movement, and exposing it as an unauthenticated POST
would let anyone mint pesos. Modelling it in the table and reading it in the fold is what
the challenge asks for; the side is a one-line DTO change the day there is a transfers flow
behind it.

### `size` xor `amount`, and no fractional shares

A request carries exactly one of the two — both, or neither, is a 400. An `amount` in pesos
becomes `floor(amount / price)` shares, priced at the close for MARKET and at the limit for
LIMIT. If the amount does not reach a single share the answer is **400 and nothing is
persisted**: unlike a rejection, there is no order to record. So is an amount that reaches
more shares than the `size` column can hold — a price and an amount can both be in range
and still divide into a number that is not.

The exclusivity is settled on the DTO rather than in the sizing it feeds, so a malformed
order is turned away before it opens a transaction or takes the placement lock, and
`{ size, amount, userId: 999 }` answers 400 for being malformed instead of 404 for a user
it should never have looked up. `resolveSize` keeps the same rule as its own precondition —
it is true of the function whoever calls it.

### Input is bounded in the shape the columns actually have

Every id and every `size` is an `INT` column and every price is `NUMERIC(10, 2)`, so that is
what the DTO and the `:id` pipe ask for: integers in `[1, 2147483647]`, money between `0.01`
and `99999999.99` with at most two decimals. Outside those ranges the answer is a **400** at
the boundary instead of a bind error, a numeric overflow, or a validator throwing on the
exponent form JavaScript prints below `1e-6` — the three ways a syntactically valid request
used to come back a 500. A well-formed id that names nothing is still a 404: the range is
about the shape of the request, not what the database holds.

The search term is never interpreted as a pattern: `position`, `starts_with` and `=`
compare strings, so `%`, `_` and `\` are characters someone typed rather than wildcards —
the escaping an `ILIKE` needs is gone rather than moved somewhere else.

### A MARKET order rejects an explicit price

The challenge only says MARKET orders do not _require_ a price. I go one step stricter:
sending one is a 400, because accepting a price and then ignoring it would execute at a
number the caller did not ask for. LIMIT orders require a positive price of at most two
decimals.

### Money is an integer count of centavos

Pesos are never a JavaScript number. A price arrives as a validated two-decimal number,
becomes a `bigint` count of centavos through its decimal string, and every calculation —
dividing an amount into whole shares, weighing a buy against the balance, adding a
portfolio up — is integer arithmetic on those centavos. The column is `NUMERIC(10, 2)`,
exact decimal storage, and what goes back out is a string with two decimals, so a client
that parses JSON into doubles is never handed a value that has already lost precision.

`bigint` rather than `number` because the widest thing the rules compute is a size times a
price: a max `INT4` size at the top of `NUMERIC(10, 2)` is roughly 2·10¹⁹ centavos, past
the 2⁵³ a double counts exactly. Integers make the guarantee structural — there is no
rounding mode to get wrong — and the three conversions in `src/money.ts` are the only
places money changes shape. `Prisma.Decimal` keeps the one job it is good for here,
carrying a `NUMERIC` value across the repository boundary; nothing does arithmetic on it.

### Nest's defaults, on purpose

No custom error envelope, no barrel files, no repository interface with a single
implementation. Every statement lives in a repository, one per module, and each method a
transaction reaches takes the transaction client as an optional last argument, so the same
method serves a caller inside a transaction and one outside it. The instrument search takes
no client, because nothing runs it in a transaction; the advisory lock requires one,
because a lock taken outside a transaction is released with the statement that takes it.
A service decides the transaction and its isolation level, when to take that lock, what
makes an instrument tradable, which statuses a cancel may come from and how many rows a
search returns; rows cross the boundary in the database's own types for it to render.

Reads that need one shape are raw SQL, because the SQL says what it does more clearly than
a stack of query-builder calls. So are the two writes: the conditional cancel puts its guard in
the statement, and the placement's `INSERT … RETURNING` hands back the row the database
ended up with. The advisory lock is the one raw statement that is neither read nor write.
Everything else goes through the Prisma client. The portfolio read runs at
`REPEATABLE READ`, so cash and positions come from one snapshot and an order settling
mid-request cannot land in both halves of `totalValue`, or in neither.

---

## Base de datos

`db/init.sql` is the challenge's `database.sql` plus the column, views and indexes below:
compose mounts it into `/docker-entrypoint-initdb.d/`, and the test containers copy it the
same way, so local runs and CI see byte-identical data (4 users, 66 instruments, 11 orders,
126 market-data rows).

Two notes on the provided schema:

- **The columns are lowercase.** The DDL is unquoted, so Postgres folded `instrumentId`,
  `userId`, `previousClose` and `accountNumber` to `instrumentid`, `userid`,
  `previousclose`, `accountnumber`. The Prisma models keep camelCase fields with `@map`, so
  the application code reads naturally while the raw SQL uses the real names.
- **`marketdata` has `date DATE`, not `datetime`.** The challenge README lists a `datetime`
  column for that table; the shipped `database.sql` — and the hosted database — have
  `date`. I followed the database.

The one change to a table is `orders.idempotencyKey` and the partial unique index over it,
[justified by what its absence
cost](#an-idempotency-key-turns-a-retried-placement-into-one-order). Nothing else moved: no
column was renamed, retyped or dropped, and every existing row and query reads as it did.
The views and indexes below are added beside the tables and change none of them.

A database built from `db/init.sql` — compose, the test containers, CI — has all of it
already; one that already exists needs the two migration files:
[`db/idempotency-key.sql`](db/idempotency-key.sql), an `ADD COLUMN IF NOT EXISTS` and its
index `IF NOT EXISTS`, and [`db/views-and-indexes.sql`](db/views-and-indexes.sql),
`CREATE OR REPLACE VIEW` and `CREATE INDEX IF NOT EXISTS`. Applying either twice is a
no-op. Both are DDL: apply them to a database you own, never to the shared challenge
database — I did not, and neither should anyone who does not own it.

```bash
docker compose exec -T db psql -U postgres -d cocos -f /dev/stdin < db/idempotency-key.sql
docker compose exec -T db psql -U postgres -d cocos -f /dev/stdin < db/views-and-indexes.sql
```

### The folds are database views

`cash_balances`, `holdings` and `latest_closes` hold the three folds the API reads: the
signed cash sum, the per-instrument net and average cost, and the latest close per
instrument. The repository queries keep the rounding, the `MONEDA` exclusion and the
`ORDER BY ticker`, and each is now a SELECT over a view — and because `holdings` answers
both the portfolio's positions and the shares check placement runs inside its lock, and
`latest_closes` both the portfolio's pricing and a MARKET order's execution price, the
number that accepts a trade and the number displayed are one definition rather than two.
Two indexes come with them, applied now rather than suggested: a partial covering
`orders(userid, instrumentid, side) INCLUDE (size, price) WHERE status = 'FILLED'`, which
answers all three folds without touching the table at all, and
`marketdata(instrumentid, date DESC)`, which the planner passes over at the seed's 126 rows
but wants once real market data arrives. A plain `orders(userid, instrumentid)` is not
among them: nothing chose it, even at volume. Measured against 35,013 orders in the compose
database: `GET /users/1/portfolio` p50 7.44 ms → 3.95 ms over 250 requests, and server-side
over 500 iterations each the cash fold 1.69 → 0.65 ms, the held-shares fold 1.92 → 0.05 ms,
and the positions query 2.60 → 0.71 ms on 424 → 40 buffers.

### Prisma is pinned to exactly 6.19.1

Prisma 7 rejects `url` inside the `datasource` block: it expects a `prisma.config.ts` and a
driver adapter instead. The pin has no caret so a fresh `npm install` cannot drift across
that break.

`npm audit` reports 4 high advisories (`deepmerge-ts`, `effect`). All of them hang off
`@prisma/config`, a dependency of the `prisma` CLI — a devDependency used for
`prisma generate`. `@prisma/client`, the only Prisma package that runs in production, has no
runtime dependencies of its own, so nothing on the served path is affected. (`npm audit
--omit=dev` still lists them because the CLI is also a peer dependency of the client.)

---

## Known limitations

Deliberate:

- **No reservation of funds for `NEW` orders** — see the first decision above.
- **`POST /orders` takes a header the challenge's endpoint does not specify**, and refuses
  a request without it — the guarantee is worth more than the extra field, [argued
  above](#an-idempotency-key-turns-a-retried-placement-into-one-order).
- **No pagination on the search.** It returns the 20 best matches and stops.
- **No authentication**, which the challenge puts out of scope: `userId` is trusted input.

## What I'd do next

1. **Reserve funds and shares** when an order is accepted, releasing them on fill or cancel
   — the one behaviour that separates this from a real order book.
2. **409 when an `Idempotency-Key` comes back with a different order** — fingerprint the
   request beside the key, so a client that reused one by mistake is told, instead of
   [handed the order the key already stands
   for](#an-idempotency-key-turns-a-retried-placement-into-one-order). Left out for now: a
   second contract to specify and store, for a mistake this API cannot currently
   distinguish from a proxy rewriting a body.
3. **Pagination and a `pg_trgm` GIN index** for the search, which today scans every
   instrument for the substring and caps the answer at 20 rows.
