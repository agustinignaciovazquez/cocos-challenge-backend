import { LedgerRow } from '../backoffice/anomaly';
import {
  cancelSafety,
  cashDelta,
  centavosOf,
  checkInvariants,
  conservation,
  moneyOf,
  noOverdraft,
  noOversell,
  responseDbAgreement,
  shareDelta,
} from './invariants';

const BMA = 31;
const PAMP = 47;

const row = (over: Partial<LedgerRow> = {}): LedgerRow => ({
  id: 1,
  userId: 1,
  instrumentId: BMA,
  side: 'BUY',
  size: 1,
  price: '100.00',
  type: 'MARKET',
  status: 'FILLED',
  ...over,
});

// The seed's own history for user 1: a million in, a few trades, and BMA left ten short.
const SEED: LedgerRow[] = [
  row({
    id: 1,
    instrumentId: 66,
    side: 'CASH_IN',
    size: 1_000_000,
    price: '1.00',
  }),
  row({ id: 2, instrumentId: PAMP, side: 'BUY', size: 50, price: '930.00' }),
  row({
    id: 3,
    instrumentId: PAMP,
    side: 'BUY',
    size: 50,
    price: '920.00',
    status: 'CANCELLED',
    type: 'LIMIT',
  }),
  row({ id: 4, instrumentId: PAMP, side: 'SELL', size: 10, price: '940.00' }),
  row({
    id: 5,
    instrumentId: 45,
    side: 'BUY',
    size: 50,
    price: '710.00',
    status: 'NEW',
    type: 'LIMIT',
  }),
  row({
    id: 6,
    instrumentId: PAMP,
    side: 'SELL',
    size: 100,
    price: '950.00',
    status: 'REJECTED',
  }),
  row({
    id: 7,
    instrumentId: BMA,
    side: 'BUY',
    size: 60,
    price: '1500.00',
    status: 'NEW',
    type: 'LIMIT',
  }),
  row({
    id: 8,
    instrumentId: 66,
    side: 'CASH_OUT',
    size: 100_000,
    price: '1.00',
  }),
  row({
    id: 9,
    instrumentId: BMA,
    side: 'BUY',
    size: 20,
    price: '1540.00',
    type: 'LIMIT',
  }),
  row({ id: 10, instrumentId: 54, side: 'BUY', size: 500, price: '250.00' }),
  row({ id: 11, instrumentId: BMA, side: 'SELL', size: 30, price: '1530.00' }),
];

const SEED_CASH = '753000.00';
const SEED_MARK = 11;

describe('money', () => {
  it('reads centavos off the exact decimal text', () => {
    expect(centavosOf('1502.80')).toBe(150280n);
    expect(centavosOf('0.01')).toBe(1n);
    expect(centavosOf('-10.50')).toBe(-1050n);
    expect(centavosOf('7')).toBe(700n);
  });

  it('keeps a value a float would lose', () => {
    // 3 x 1502.80 is 4508.400000000001 in binary floating point.
    expect(moneyOf(centavosOf('1502.80') * 3n)).toBe('4508.40');
  });

  it('renders both signs with two decimals', () => {
    expect(moneyOf(0n)).toBe('0.00');
    expect(moneyOf(-5n)).toBe('-0.05');
    expect(moneyOf(100_000_000n)).toBe('1000000.00');
  });
});

describe('the folds the challenge computes in SQL', () => {
  it('credits a sale and a cash-in, debits a purchase and a cash-out', () => {
    expect(cashDelta(row({ side: 'SELL', size: 2, price: '10.50' }))).toBe(
      2100n,
    );
    expect(cashDelta(row({ side: 'CASH_IN', size: 2, price: '10.50' }))).toBe(
      2100n,
    );
    expect(cashDelta(row({ side: 'BUY', size: 2, price: '10.50' }))).toBe(
      -2100n,
    );
    expect(cashDelta(row({ side: 'CASH_OUT', size: 2, price: '10.50' }))).toBe(
      -2100n,
    );
  });

  it('counts nothing an order that did not fill', () => {
    for (const status of ['NEW', 'REJECTED', 'CANCELLED']) {
      expect(cashDelta(row({ status }))).toBe(0n);
      expect(shareDelta(row({ status }))).toBe(0);
    }
  });

  it('leaves a side it does not recognise out of both folds', () => {
    expect(cashDelta(row({ side: 'DIVIDEND' }))).toBe(0n);
    expect(shareDelta(row({ side: 'CASH_IN', size: 500 }))).toBe(0);
  });

  it('moves shares only on a filled buy or sell', () => {
    expect(shareDelta(row({ side: 'BUY', size: 7 }))).toBe(7);
    expect(shareDelta(row({ side: 'SELL', size: 7 }))).toBe(-7);
  });
});

describe('conservation', () => {
  const reading = (cash: string) => new Map([[1, { cash }]]);
  const api = reading(SEED_CASH);
  const shadow = new Map([[1, SEED_CASH]]);

  it('holds when all three agree', () => {
    const result = conservation(SEED, api, shadow);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain(
      `API ${SEED_CASH} == fold ${SEED_CASH} == shadow`,
    );
  });

  it('breaks when the API balance is not the fold', () => {
    const result = conservation(SEED, reading('753000.01'), shadow);
    expect(result.pass).toBe(false);
    expect(result.detail).toBe(
      'user 1: API says 753000.01, the FILLED fold says 753000.00',
    );
  });

  it('breaks when the shadow disagrees with a target that agrees with itself', () => {
    const result = conservation(SEED, api, new Map([[1, '750000.00']]));
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('the shadow says 750000.00');
  });

  it('compares the two legs it has when the shadow is not comparable', () => {
    const result = conservation(SEED, api, new Map());
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('shadow leg not comparable');
  });

  // Conservation is a claim about what the ledger says. A target that did not answer has not
  // broken it, it has left it unchecked — and the outage is loud elsewhere already.
  it('skips a balance it could not read at all rather than calling it a violation', () => {
    const result = conservation(SEED, new Map(), shadow);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('API leg not comparable');
    expect(result.detail).toContain('no API balance was read');
  });

  // A balance and the rows behind it are two round trips. An order settling between them
  // moves one and not the other, and that disagreement is the reader's, not the target's.
  it('skips a balance that did not stand still across the reading', () => {
    const moved = new Map([
      [1, { unavailable: 'it read 1.00 before the rows and 2.00 after them' }],
    ]);
    const result = conservation(SEED, moved, shadow);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('API leg not comparable');
    expect(result.detail).toContain('the FILLED fold says 753000.00');
  });

  it('does not let a moved balance hide a shadow that disagrees', () => {
    // The shadow leg is not reached when the API leg was skipped, so the run reports what it
    // could not compare rather than a clean pass it did not earn.
    const moved = new Map([[1, { unavailable: 'it moved' }]]);
    const result = conservation(SEED, moved, new Map([[1, '1.00']]));
    expect(result.detail).toContain('API leg not comparable');
    expect(result.detail).not.toContain('== shadow');
  });

  it('compares as exact strings, not as numbers', () => {
    const result = conservation(SEED, reading('753000.0'), shadow);
    expect(result.pass).toBe(false);
  });

  it('folds each user apart from the others', () => {
    const rows = [
      ...SEED,
      row({
        id: 12,
        userId: 2,
        side: 'CASH_IN',
        instrumentId: 66,
        size: 500,
        price: '1.00',
      }),
    ];
    const result = conservation(
      rows,
      new Map([
        [1, { cash: SEED_CASH }],
        [2, { cash: '500.00' }],
      ]),
      new Map(),
    );
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('user 2: API 500.00 == fold 500.00');
  });
});

describe('no overdraft', () => {
  it('holds over a history that never spends what it does not have', () => {
    const result = noOverdraft(SEED);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('never dipped below 0.00');
  });

  it('breaks when two buys together outspend the balance, and names the order', () => {
    const rows = [
      row({
        id: 1,
        instrumentId: 66,
        side: 'CASH_IN',
        size: 1000,
        price: '1.00',
      }),
      row({ id: 2, side: 'BUY', size: 6, price: '100.00' }),
      row({ id: 3, side: 'BUY', size: 6, price: '100.00' }),
    ];
    const result = noOverdraft(rows);
    expect(result.pass).toBe(false);
    expect(result.detail).toBe(
      'user 1: the cash fold reached -200.00 at order 3',
    );
  });

  it('reports the lowest point, not the last one', () => {
    const rows = [
      row({
        id: 1,
        instrumentId: 66,
        side: 'CASH_IN',
        size: 100,
        price: '1.00',
      }),
      row({ id: 2, side: 'BUY', size: 5, price: '100.00' }),
      row({ id: 3, side: 'SELL', size: 5, price: '100.00' }),
    ];
    expect(noOverdraft(rows).detail).toContain('-400.00 at order 2');
  });

  it('does not let the surplus of one user cover the overdraft of another', () => {
    const rows = [
      row({
        id: 1,
        instrumentId: 66,
        side: 'CASH_IN',
        size: 1000,
        price: '1.00',
      }),
      row({ id: 2, userId: 2, side: 'BUY', size: 1, price: '100.00' }),
    ];
    const result = noOverdraft(rows);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('user 2');
  });
});

describe('no oversell', () => {
  it('holds over the seed, whose BMA floor is ten short', () => {
    const result = noOversell(SEED, SEED_MARK);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('1/31 floor -10');
  });

  it('lets the run trade back up from a floor the seed left negative', () => {
    const rows = [
      ...SEED,
      row({ id: 12, side: 'BUY', size: 3 }),
      row({ id: 13, side: 'SELL', size: 3 }),
    ];
    expect(noOversell(rows, SEED_MARK).pass).toBe(true);
  });

  it('breaks when a run order takes a position under its floor', () => {
    const rows = [...SEED, row({ id: 12, side: 'SELL', size: 1 })];
    const result = noOversell(rows, SEED_MARK);
    expect(result.pass).toBe(false);
    expect(result.detail).toBe(
      'user 1 instrument 31: order 12 took the position to -11, under its floor of -10',
    );
  });

  it('breaks when a position that started at zero goes short', () => {
    const rows = [row({ id: 12, instrumentId: PAMP, side: 'SELL', size: 4 })];
    const result = noOversell(rows, 11);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('to -4, under its floor of 0');
  });

  it('takes the floor from the rows the run did not write', () => {
    // The same two rows, but now the seed's short position is inside the run window: a
    // floor read from the run's own rows would excuse the very dip it is meant to catch.
    const result = noOversell(SEED, 10);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('order 11 took the position to -10');
  });

  it('keeps each instrument on its own floor', () => {
    const rows = [
      ...SEED,
      row({ id: 12, instrumentId: PAMP, side: 'SELL', size: 40 }),
    ];
    expect(noOversell(rows, SEED_MARK).pass).toBe(true);
  });
});

describe('response and database agreement', () => {
  const answered = [
    { orderId: 12, status: 'FILLED', size: 3, price: '1502.80' },
  ];
  const created = row({ id: 12, size: 3, price: '1502.80' });

  it('holds when every answer names a row that says the same thing', () => {
    const result = responseDbAgreement(
      answered,
      [...SEED, created],
      SEED_MARK,
      new Set([12]),
      0,
    );
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('1 answered orders match their rows');
  });

  it('breaks when the target answered for an order it never wrote', () => {
    const result = responseDbAgreement(answered, SEED, SEED_MARK, new Set(), 0);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('the database holds no such row');
  });

  it('breaks when the row disagrees with the answer', () => {
    for (const wrong of [
      { status: 'REJECTED' },
      { size: 4 },
      { price: '1502.81' },
    ]) {
      const result = responseDbAgreement(
        answered,
        [...SEED, { ...created, ...wrong }],
        SEED_MARK,
        new Set([12]),
        0,
      );
      expect(result.pass).toBe(false);
      expect(result.detail).toContain('order 12: the response said');
    }
  });

  it('breaks on a row in the run window that nothing answered for', () => {
    const result = responseDbAgreement(
      [],
      [...SEED, created],
      SEED_MARK,
      new Set(),
      0,
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain(
      '1 rows in the run window were never answered for but only 0 calls went unanswered: 12',
    );
  });

  it('allows exactly as many unanswered rows as there were unanswered calls', () => {
    const result = responseDbAgreement(
      [],
      [...SEED, created],
      SEED_MARK,
      new Set(),
      1,
    );
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('1 unmatched against 1 unanswered calls');
  });

  it('leaves the rows the run did not create out of the backward direction', () => {
    const result = responseDbAgreement([], SEED, SEED_MARK, new Set(), 0);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('0 rows created in the run');
  });

  // The row is read after the run finished, so a resting order the run went on to cancel
  // reads CANCELLED however honest the target was — that is the run's own doing.
  const rested = [{ orderId: 12, status: 'NEW', size: 1, price: '1.00' }];
  const cancelledRow = row({
    id: 12,
    size: 1,
    price: '1.00',
    type: 'LIMIT',
    status: 'CANCELLED',
  });

  it('excuses a resting order the run itself cancelled', () => {
    const result = responseDbAgreement(
      rested,
      [...SEED, cancelledRow],
      SEED_MARK,
      new Set([12]),
      0,
      [12],
    );
    expect(result.pass).toBe(true);
  });

  it('breaks on an order that was cancelled without the run asking', () => {
    const result = responseDbAgreement(
      rested,
      [...SEED, cancelledRow],
      SEED_MARK,
      new Set([12]),
      0,
      [],
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('the row says CANCELLED');
  });

  it('does not excuse a filled order that ended up cancelled', () => {
    const result = responseDbAgreement(
      [{ orderId: 12, status: 'FILLED', size: 1, price: '1.00' }],
      [...SEED, cancelledRow],
      SEED_MARK,
      new Set([12]),
      0,
      [12],
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('the response said FILLED');
  });

  it('reports enough breaches to see the shape and counts the rest', () => {
    const many = Array.from({ length: 8 }, (_, at) => ({
      orderId: 100 + at,
      status: 'FILLED',
      size: 1,
      price: '1.00',
    }));
    const result = responseDbAgreement(many, SEED, SEED_MARK, new Set(), 0);
    expect(result.detail.split('; ').length).toBe(5);
    expect(result.detail).toContain('(and 3 more)');
  });
});

describe('cancel safety', () => {
  const cancelled = row({
    id: 12,
    status: 'CANCELLED',
    type: 'LIMIT',
    price: '1.00',
  });

  it('holds when every order the API cancelled reads cancelled and moves nothing', () => {
    const result = cancelSafety([...SEED, cancelled], [12]);
    expect(result.pass).toBe(true);
    expect(result.detail).toContain('2 CANCELLED rows contribute nothing');
  });

  it('breaks when a cancelled order reads as filled', () => {
    const result = cancelSafety(
      [...SEED, { ...cancelled, status: 'FILLED' }],
      [12],
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toBe('order 12 was cancelled but reads FILLED');
  });

  it('breaks when a cancelled order left the row untouched', () => {
    const result = cancelSafety(
      [...SEED, { ...cancelled, status: 'NEW' }],
      [12],
    );
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('reads NEW');
  });

  it('breaks when a cancelled order has no row at all', () => {
    const result = cancelSafety(SEED, [12]);
    expect(result.pass).toBe(false);
    expect(result.detail).toContain('the database holds no such row');
  });

  it('leaves both folds where they were when the cancelled rows are dropped', () => {
    const withCancels = [...SEED, cancelled];
    const before = conservation(
      withCancels,
      new Map([[1, { cash: SEED_CASH }]]),
      new Map(),
    );
    expect(before.pass).toBe(true);
    expect(cancelSafety(withCancels, []).pass).toBe(true);
  });
});

describe('the checker as a whole', () => {
  it('runs all five and reports them in order', () => {
    const results = checkInvariants({
      rows: SEED,
      highWaterMark: SEED_MARK,
      apiCash: new Map([[1, { cash: SEED_CASH }]]),
      shadowCash: new Map([[1, SEED_CASH]]),
      placements: [],
      acknowledged: new Set(),
      unanswered: 0,
      cancelled: [],
    });
    expect(results.map(({ name }) => name)).toEqual([
      'conservation',
      'no_overdraft',
      'no_oversell',
      'response_db_agreement',
      'cancel_safety',
    ]);
    expect(results.every(({ pass }) => pass)).toBe(true);
  });
});
