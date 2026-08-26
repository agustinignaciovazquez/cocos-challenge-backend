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

That is the whole setup: compose seeds the database itself, so there is no migration step
and nothing to import by hand; `--wait` holds until the healthcheck passes, so the dev
server never opens a pool against a database that is still seeding.
`docker compose down -v` throws the data away and the next `up` reseeds from
`db/init.sql`. To run against the challenge's hosted database instead, point
`DATABASE_URL` at it — `.env.example` carries the commented line.

- Interactive docs: <http://localhost:3000/docs> (OpenAPI JSON at `/docs-json`)
- Ready-to-send calls: [`requests.http`](requests.http) — 34 cases, every endpoint with
  its happy and failure paths, for the VS Code REST Client extension

`npm run start:prod` serves the compiled build; `PORT` overrides the port.

### Tests

```bash
npm test         # 31 unit + 40 e2e
npm run test:unit
npm run test:e2e # needs a running Docker daemon
```

Unit tests cover the money conversions at their boundaries, the pure order rules — sizing,
the accept/reject decision, the status transitions — and the HTTP status each failure of a
placement maps to. Every DB-backed test
runs against a throwaway Postgres 16 that `@testcontainers/postgresql` starts and seeds
from `db/init.sql`; no test ever touches a shared database. Five of them pin concurrency:
simultaneous buys against one balance,
simultaneous sells against one position, simultaneous cancels of one order, a placement
blocked behind a held advisory lock, and a cancel settling beside a placement.

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
114750 − 15028 = 889756. The short BMA line is [the seed's own arithmetic, reported
rather than hidden](#the-seeds-10-bma-position-is-reported-honestly).

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

---

## Decisiones y supuestos

### Balances fold `FILLED` orders only — a `NEW` order reserves nothing

The challenge says to compute the tenencia and the pesos disponibles from the movements in
`orders`, using `FILLED` rows for each position. So `availableCash` is
`CASH_IN + SELL proceeds − CASH_OUT − BUY cost` over that user's `FILLED` orders, and each
position is `BUY − SELL` sizes of one instrument.

The consequence is deliberate and worth stating: an open limit order holds no money. A user
with 100.000 pesos can leave two open limit buys of 100.000 each — both passed the check
when they were sent, and neither has spent anything yet. The production answer is to reserve
the funds (or the shares) when the order is accepted and release them on fill or cancel,
which needs a balance the API owns rather than one derived from the order log. That is the
first item under [what I'd do next](#what-id-do-next); I left it out because it changes the
data model the challenge handed me.

### Total return is measured against the position's cost basis

`totalReturnPct = (latestClose − avgCost) / avgCost × 100`, rounded to two decimals, with
`avgCost` the size-weighted average price of the `FILLED` BUYs of that instrument
(`Σ size·price / Σ size`). Sells reduce the quantity, not the average — average-cost, not
FIFO, which is the convention a broker statement uses for _rendimiento total_.

It is `null` when the number would not mean anything: a negative (short) position, where the
ratio's sign flips; a position with no purchase to give it a cost basis; an instrument with
no market data.

The challenge also mentions `close` and `previousClose` — that pair gives the instrument's
_daily_ return, a different figure from the position's total return the portfolio asks for.
I compute the total return; the daily one is a one-line addition to the same query if it is
wanted.

### MARKET executes at the latest close; LIMIT parks at its price

There is no market to simulate, so a MARKET order fills immediately at the `close` of the
most recent `marketdata` row for that instrument (`ORDER BY date DESC LIMIT 1` — the seed
carries two days of prices for every instrument that has any, so the ordering matters). Two
seeded equities carry no prices at all; an order for either is a 400 rather than a fill
at an invented price.

A LIMIT order is persisted as `NEW` at the price the user sent and stays there until it is
cancelled: nothing in this service crosses it against a price later on.

### A `REJECTED` order is a 201, not a 4xx

If the pesos do not cover a buy, or the shares do not cover a sell, the order is persisted
with status `REJECTED` and returned with **201**. The HTTP request succeeded — the market's
verdict is the payload. The row is exactly what the challenge asks to record, and a client
that reads the status handles the outcome; a 4xx would tell it the request was malformed,
which it was not.

4xx is kept for what it means: **400** malformed or unfulfillable input, **404** unknown
user, instrument or order, **409** an order whose status forbids the transition. And one
5xx is not a bug: **503** when the placement transaction runs out of its budget waiting for
its turn behind the [advisory lock](#concurrency-one-advisory-lock-for-placement-a-conditional-update-for-cancellation)
— the server is busy, and the same request is worth sending again.

### Concurrency: one advisory lock for placement, a conditional UPDATE for cancellation

Placement reads a balance and then writes an order that depends on it, so the two must not
interleave. The whole placement runs in one transaction that opens with
`SELECT pg_advisory_xact_lock(userId)`: a user's orders are serialised against each other,
different users never contend, and the lock is released with the transaction — there is
nothing to clean up if the request dies. Two simultaneous buys against the same balance —
or two sells against the same position — therefore produce one `FILLED` and one
`REJECTED`, which is what the e2e suite asserts.

The transaction is pinned to `READ COMMITTED`, which is what makes the lock mean anything:
the balance has to be read after the wait, and a repeatable-read snapshot would predate it
and still show the cash the holder just spent. An e2e test holds the lock from a second
connection, spends the balance there, and asserts the blocked placement wakes up
`REJECTED`.

The transaction carries an explicit budget — 5s to get a connection, 10s to run — because
both bound queueing rather than work: the placement itself is half a dozen indexed
statements. When either runs out Prisma raises `P2028`, and that is answered **503**, not
500: a placement that never got its turn is a load condition, and the caller's order is
intact to send again. The created row is read back from the `INSERT … RETURNING`, so the
response reports what Postgres stored rather than a reconstruction of what was sent to it.

Alternatives I did not take: `SERIALIZABLE` isolation is correct but turns a preventable
conflict into a serialization failure every caller has to retry; an optimistic version
column needs a balance row to version, and my balance is derived from the order log.

Cancellation needs no lock at all. The transition _is_ the UPDATE's predicate —
`UPDATE orders SET status = 'CANCELLED' WHERE id = $1 AND status IN ('NEW') RETURNING …` —
so of two concurrent cancels only one matches a row and the other reads back the current
status to answer 409. Placement only ever INSERTs, so it cannot race with a cancel, and
cancelling moves no cash because a `NEW` order reserved none — the day reservation lands,
cancel becomes balance-mutating and has to take the same lock.

### The seed's −10 BMA position is reported honestly

User 1 sold 30 BMA against 20 bought, so the fold yields quantity −10, marketValue
−15028.00 and `totalReturnPct: null`. I did not clamp it to zero or hide it: the data says
the account is short, and a portfolio endpoint that quietly disagrees with the ledger is
worse than one that shows an uncomfortable number. New orders cannot deepen it — a sell
beyond the held shares is `REJECTED`.

### A position in an instrument with no market data is valued at 0

`marketValue` is `ROUND(quantity × COALESCE(latest.close, 0), 2)`, so a holding of an
instrument that carries no `marketdata` row at all — PGR and IRCP in the seed — is listed
with its quantity and the cost basis its buys give it, a `marketValue` of `0.00` and a
`null` total return, and contributes nothing to `totalValue`. Nothing this service does
can create such a holding — the missing price is the same one that turns an order for
either into [a 400](#market-executes-at-the-latest-close-limit-parks-at-its-price) — so
the case only arrives with data loaded from outside the API.

The alternative is to leave those lines out of `totalValue`, or to report their value as
`null`, which states "price unknown" instead of implying "worth nothing". I did not take
it: excluding the line hands back a total that no longer equals the sum of the positions
shown above it, reporting `null` changes the type of a money field, and neither is worth a
contract change for a case the seed never reaches. It is also the reading the [−10 BMA
line](#the-seeds-10-bma-position-is-reported-honestly) already gets — the ledger is
reported as it stands, the position visible rather than dropped, with only its price
missing.

### Cash is the `MONEDA` instrument; `CASH_IN`/`CASH_OUT` are data, not an endpoint

ARS is instrument 66, type `MONEDA`, and transfers are `orders` rows with `price = 1` and
`size` in pesos. Both sides are folded into `availableCash`, so the seeded transfers count.
`MONEDA` is excluded from search results and from the positions list (it _is_ the
`availableCash` line), and it cannot be traded: `POST /orders` for it answers 400.

`POST /orders` accepts `BUY` and `SELL` only. A deposit is not an order sent to the market:
it is the settlement of an external movement, and exposing it as an unauthenticated POST
would let anyone mint pesos. Modelling it in the table and reading it in the fold is what
the challenge asks for; the side is a one-line DTO change the day there is a transfers flow
behind it.

### `size` xor `amount`, and no fractional shares

A request carries exactly one of the two — both, or neither, is a 400. An `amount` in pesos
becomes `floor(amount / price)` shares, priced at the close for MARKET and at the limit for
LIMIT. If the amount does not reach a single share the answer is **400 and nothing is
persisted**: unlike a rejection, there is no order here for the market to have an opinion
about. So is an amount that reaches more shares than the `size` column can hold — a price
and an amount can both be in range and still divide into a number that is not.

The exclusivity is settled on the DTO rather than inside the sizing it feeds, so a
malformed order is turned away before it opens a transaction or takes the placement lock,
and `{ size, amount, userId: 999 }` answers 400 for being malformed instead of 404 for a
user it should never have looked up. `resolveSize` keeps the same rule as its own
precondition — it is true of the function whoever calls it.

### Input is bounded in the shape the columns actually have

Every id and every `size` is an `INT` column and every price is `NUMERIC(10, 2)`, so that is
what the DTO and the `:id` pipe ask for: integers in `[1, 2147483647]`, money between `0.01`
and `99999999.99` with at most two decimals. Outside those ranges the answer is a **400** at
the boundary instead of a bind error, a numeric overflow, or a validator throwing on the
exponent form JavaScript prints below `1e-6` — the three ways a syntactically valid request
used to come back a 500. A well-formed id that names nothing is still a 404: the range is
about the shape of the request, not about what the database happens to hold.

The search term is never interpreted as a pattern: `position`, `starts_with` and `=`
compare strings, so `%`, `_` and `\` are characters someone typed rather than wildcards
they get to use — the escaping an `ILIKE` needs is gone rather than moved somewhere else.

### A MARKET order rejects an explicit price

The challenge only says MARKET orders do not _require_ a price. I go one step stricter:
sending one is a 400. Accepting a price and then silently ignoring it would execute at a
number the caller did not ask for, and that is the kind of surprise a trading API should not
have. LIMIT orders require a positive price of at most two decimals.

### Money is an integer count of centavos

Pesos are never a JavaScript number. A price arrives as a validated two-decimal number,
becomes a `bigint` count of centavos through its decimal string, and every calculation the
application makes — dividing an amount into whole shares, weighing a buy against the
balance, adding a portfolio up — is integer arithmetic on those centavos. The column is
`NUMERIC(10, 2)`, which is exact decimal storage, and what goes back out is a string with
two decimals. A client that parses JSON into doubles is never handed a value that has
already lost precision.

`bigint` rather than `number` because the widest thing the rules compute is a size times a
price, and a max `INT4` size at the top of `NUMERIC(10, 2)` is roughly 2·10¹⁹ centavos —
past the 2⁵³ a double counts exactly. Integers make the guarantee structural rather than
something a library holds for me: there is no rounding mode to get wrong, and the three
conversions in `src/money.ts` are the only places in the application where money changes
shape. `Prisma.Decimal` is left with the single job it is good for here, carrying a
`NUMERIC` value across the repository boundary; nothing does arithmetic on it.

### Nest's defaults, on purpose

No custom error envelope, no barrel files, no repository interface with a single
implementation. Reads that need one shape are raw SQL: the portfolio fold is two
`$queryRaw` calls, the cash balance and the positions, and the ranked search, the shares
held of an instrument and the latest close are one each — the SQL says what it does more
clearly than a stack of query-builder calls. So are the two writes, for reasons of their
own: the conditional cancel puts its guard in the statement, and the placement's
`INSERT … RETURNING` hands back the row the database ended up with. Everything else goes
through the Prisma client. The portfolio read runs at `REPEATABLE READ` so cash and
positions come from one snapshot and an order settling mid-request cannot land in both
halves of `totalValue`, or in neither.

---

## Base de datos

`db/init.sql` is the challenge's `database.sql` verbatim: compose mounts it into
`/docker-entrypoint-initdb.d/`, and the test containers copy it in the same way, so local
runs and CI see byte-identical data (4 users, 66 instruments, 11 orders, 126 market-data
rows).

Two things about the provided schema are worth flagging:

- **The columns are lowercase.** The DDL is unquoted, so Postgres folded `instrumentId`,
  `userId`, `previousClose` and `accountNumber` to `instrumentid`, `userid`,
  `previousclose`, `accountnumber`. The Prisma models keep camelCase fields with `@map`, so
  the application code reads naturally while the raw SQL uses the real names.
- **`marketdata` has `date DATE`, not `datetime`.** The challenge README lists a `datetime`
  column for that table; the shipped `database.sql` — and the hosted database — have
  `date`. I followed the database.

I did not modify the schema. `db/indexes.sql` holds the two indexes the queries in this
service would want — `orders(userid, instrumentid)` and
`marketdata(instrumentid, date DESC)`, each with its justification — but they are **not**
applied automatically, and they must be applied to a local database only, never to the
shared challenge database:

```bash
docker compose exec -T db psql -U postgres -d cocos -f /dev/stdin < db/indexes.sql
```

### Prisma is pinned to exactly 6.19.1

Prisma 7 rejects `url` inside the `datasource` block: it expects a `prisma.config.ts` and a
driver adapter instead. The pin has no caret so a fresh `npm install` cannot drift across
that break.

`npm audit` reports 4 high advisories (`deepmerge-ts`, `effect`). All of them hang off
`@prisma/config`, which is a dependency of the `prisma` CLI — a devDependency used for
`prisma generate`. `@prisma/client`, the only Prisma package that runs in production, has no
runtime dependencies of its own, so nothing on the served path is affected. (`npm audit
--omit=dev` still lists them because the CLI is also a peer dependency of the client.)

---

## Known limitations

Deliberate, and worth naming rather than leaving to be found:

- **No reservation of funds for `NEW` orders** — see the first decision above.
- **No pagination on the search.** It returns the 20 best matches and stops.
- **No authentication**, which the challenge puts out of scope: `userId` is trusted input.

## What I'd do next

1. **Reserve funds and shares** when an order is accepted, releasing them on fill or cancel
   — the one behaviour that separates this from a real order book.
2. **Idempotency keys on `POST /orders`**, so a client that retries after a timeout cannot
   place the same order twice.
3. **Pagination and a `pg_trgm` GIN index** for the search, which today scans every
   instrument for the substring and caps the answer at 20 rows.
