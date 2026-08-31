import { MarketOrder, OrderStatus } from '../order';
import { ShadowLedger } from './shadow-ledger';

const PAMP = 47;
const METR = 54;

const order = (over: Partial<MarketOrder> = {}): MarketOrder => ({
  userId: 1,
  instrumentId: PAMP,
  side: 'BUY',
  size: 10,
  type: 'MARKET',
  ...over,
});

// A rejected order for a user this ledger was never given moves nothing, but it still
// carries the close the target priced it at — which is the only way a price is learned.
const teach = (
  ledger: ShadowLedger,
  instrumentId: number,
  price: string,
): void => {
  ledger.settle(ledger.reserve(order({ userId: 999, instrumentId })), {
    status: 'REJECTED',
    price,
  });
};

// One seeded user, with PAMP priced at 100.00 a share.
const priced = (availableCash: string, quantity = 0): ShadowLedger => {
  const ledger = new ShadowLedger();
  ledger.reseed([1]);
  ledger.seed(ledger.generation, 1, {
    availableCash,
    positions: quantity === 0 ? [] : [{ instrumentId: PAMP, quantity }],
  });
  teach(ledger, PAMP, '100.00');
  return ledger;
};

const expectationOf = (ledger: ShadowLedger, sent: MarketOrder): string =>
  ledger.reserve(sent).expectation;

const settle = (
  ledger: ShadowLedger,
  sent: MarketOrder,
  status: OrderStatus,
  price: string,
): void => ledger.settle(ledger.reserve(sent), { status, price });

describe('ShadowLedger expectations', () => {
  it('holds no opinion before it has seen a price for the instrument', () => {
    const ledger = new ShadowLedger();
    ledger.reseed([1]);
    ledger.seed(ledger.generation, 1, {
      availableCash: '1000.00',
      positions: [],
    });

    expect(expectationOf(ledger, order())).toBe('UNKNOWN');
  });

  it('holds no opinion about a user it was never given', () => {
    expect(expectationOf(priced('1000.00'), order({ userId: 2 }))).toBe(
      'UNKNOWN',
    );
  });

  it('holds no opinion about a user whose seed never landed', () => {
    const ledger = new ShadowLedger();
    ledger.reseed([1]);
    teach(ledger, PAMP, '100.00');

    expect(expectationOf(ledger, order())).toBe('UNKNOWN');
  });

  it('expects a buy of exactly the available cash to fill', () => {
    expect(expectationOf(priced('1000.00'), order({ size: 10 }))).toBe(
      'FILLED',
    );
  });

  it('expects a buy one centavo past the available cash to be rejected', () => {
    expect(expectationOf(priced('999.99'), order({ size: 10 }))).toBe(
      'REJECTED',
    );
  });

  it('expects a sell of exactly the held shares to fill', () => {
    expect(
      expectationOf(priced('0.00', 10), order({ side: 'SELL', size: 10 })),
    ).toBe('FILLED');
  });

  it('expects a sell beyond the held shares to be rejected', () => {
    expect(
      expectationOf(priced('0.00', 9), order({ side: 'SELL', size: 10 })),
    ).toBe('REJECTED');
  });

  it('expects a sell with nothing held to be rejected', () => {
    expect(
      expectationOf(priced('1000.00'), order({ side: 'SELL', size: 1 })),
    ).toBe('REJECTED');
  });
});

describe('ShadowLedger reservations', () => {
  it('does not let two overlapping buys spend the same pesos', () => {
    const ledger = priced('1000.00');

    const first = ledger.reserve(order({ size: 10 }));
    const second = ledger.reserve(order({ size: 10 }));

    expect(first.expectation).toBe('FILLED');
    // The pesos the first is holding are not offered to the second, which is why it holds
    // nothing of its own. What the shadow stops short of is calling the rejection: the first
    // order may still turn out to consume nothing.
    expect(second).toMatchObject({ expectation: 'UNKNOWN', heldCash: 0 });
  });

  it('gives the pesos back when the first of the two is not filled', () => {
    const ledger = priced('1000.00');
    const first = ledger.reserve(order({ size: 10 }));

    ledger.settle(first, { status: 'REJECTED', price: '100.00' });

    expect(expectationOf(ledger, order({ size: 10 }))).toBe('FILLED');
  });

  it('keeps the pesos spent when the first of the two is filled', () => {
    const ledger = priced('1000.00');
    const first = ledger.reserve(order({ size: 10 }));

    ledger.settle(first, { status: 'FILLED', price: '100.00' });

    expect(expectationOf(ledger, order({ size: 10 }))).toBe('REJECTED');
  });

  it('does not let two overlapping sells deliver the same shares', () => {
    const ledger = priced('0.00', 10);

    const first = ledger.reserve(order({ side: 'SELL', size: 10 }));
    const second = ledger.reserve(order({ side: 'SELL', size: 1 }));

    expect(first.expectation).toBe('FILLED');
    expect(second).toMatchObject({ expectation: 'UNKNOWN', heldShares: 0 });
  });

  // Only concurrency separates the two predictions. A hold assumes every unsettled order
  // consumes what it reserved, so a cover survives whatever they turn out to be — being
  // short does not, and under load shedding it is wrong far more often than it is right.
  it('stops calling a rejection while anything else is still in flight', () => {
    const ledger = priced('1000.00');
    ledger.reserve(order({ size: 10 }));

    expect(expectationOf(ledger, order({ size: 10 }))).toBe('UNKNOWN');
  });

  it('still calls a fill while other orders are in flight', () => {
    const ledger = priced('1000.00');
    ledger.reserve(order({ size: 1 }));

    expect(expectationOf(ledger, order({ size: 5 }))).toBe('FILLED');
  });

  it('holds nothing for an order it already expects to be rejected', () => {
    const ledger = priced('1000.00');

    const tooBig = ledger.reserve(order({ size: 50 }));

    expect(tooBig).toMatchObject({ expectation: 'REJECTED', heldCash: 0 });
    expect(expectationOf(ledger, order({ size: 10 }))).toBe('FILLED');
  });
});

describe('ShadowLedger generations', () => {
  it('drops a settlement that belongs to a shadow it has thrown away', () => {
    const ledger = priced('1000.00');
    const inFlight = ledger.reserve(order({ size: 4 }));

    ledger.reseed([1]);
    ledger.seed(ledger.generation, 1, {
      availableCash: '1000.00',
      positions: [],
    });
    ledger.settle(inFlight, { status: 'FILLED', price: '100.00' });

    expect(ledger.snapshot().users[0]).toMatchObject({
      cash: '1000.00',
      positions: [],
    });
  });

  it('refuses a seed that belongs to a shadow it has thrown away', () => {
    const ledger = new ShadowLedger();
    ledger.reseed([1]);
    const stale = ledger.generation;
    ledger.reseed([1]);

    expect(
      ledger.seed(stale, 1, { availableCash: '5.00', positions: [] }),
    ).toBe(false);
    expect(ledger.snapshot().users[0]).toMatchObject({
      cash: '0.00',
      seeded: false,
    });
  });
});

describe('ShadowLedger lost responses', () => {
  it('stops trusting a user whose order never came back', () => {
    const ledger = priced('1000.00');

    ledger.lose(ledger.reserve(order({ size: 1 })));

    expect(ledger.snapshot().users[0].uncertain).toBe(true);
    expect(expectationOf(ledger, order({ size: 1 }))).toBe('UNKNOWN');
  });

  it('trusts the user again once its portfolio has been read back', () => {
    const ledger = priced('1000.00');
    ledger.lose(ledger.reserve(order({ size: 1 })));
    expect(ledger.needsReseed(1)).toBe(true);

    ledger.seed(ledger.generation, 1, {
      availableCash: '900.00',
      positions: [],
    });

    expect(ledger.snapshot().users[0]).toMatchObject({
      cash: '900.00',
      uncertain: false,
    });
    expect(expectationOf(ledger, order({ size: 1 }))).toBe('FILLED');
  });

  it('waits for every order in flight before asking for a re-read', () => {
    const ledger = priced('1000.00');
    const inFlight = ledger.reserve(order({ size: 1 }));
    ledger.lose(ledger.reserve(order({ size: 1 })));

    expect(ledger.needsReseed(1)).toBe(false);

    ledger.settle(inFlight, { status: 'FILLED', price: '100.00' });
    expect(ledger.needsReseed(1)).toBe(true);
  });

  it('stays untrusted when a re-read lands with an order still in flight', () => {
    const ledger = priced('1000.00');
    ledger.reserve(order({ size: 1 }));
    ledger.lose(ledger.reserve(order({ size: 1 })));

    ledger.seed(ledger.generation, 1, {
      availableCash: '900.00',
      positions: [],
    });

    expect(ledger.snapshot().users[0].uncertain).toBe(true);
  });

  it('asks for a re-read of a user whose first seed never landed', () => {
    const ledger = new ShadowLedger();
    ledger.reseed([1]);

    expect(ledger.needsReseed(1)).toBe(true);
  });
});

describe('ShadowLedger bookkeeping', () => {
  it('pays for a filled buy and credits the shares', () => {
    const ledger = priced('1000.00');

    settle(ledger, order({ size: 4 }), 'FILLED', '100.00');

    expect(ledger.snapshot().users[0]).toMatchObject({
      cash: '600.00',
      positions: [{ instrumentId: PAMP, quantity: 4 }],
    });
  });

  it('collects a filled sell and debits the shares', () => {
    const ledger = priced('0.00', 10);

    settle(ledger, order({ side: 'SELL', size: 4 }), 'FILLED', '925.85');

    expect(ledger.snapshot().users[0]).toMatchObject({
      cash: '3703.40',
      positions: [{ instrumentId: PAMP, quantity: 6 }],
    });
  });

  it('moves nothing for an order the API did not fill', () => {
    const ledger = priced('1000.00');

    settle(ledger, order({ size: 4 }), 'REJECTED', '100.00');

    expect(ledger.snapshot().users[0]).toMatchObject({
      cash: '1000.00',
      positions: [],
    });
  });

  it('follows the actual outcome even when it contradicts the expectation', () => {
    const ledger = priced('1000.00');
    const buy = ledger.reserve(order({ size: 50 }));
    expect(buy.expectation).toBe('REJECTED');

    ledger.settle(buy, { status: 'FILLED', price: '100.00' });

    expect(ledger.snapshot().users[0].cash).toBe('-4000.00');
  });

  it('learns each instrument price from the response that carried it', () => {
    const ledger = priced('1000.00');

    settle(ledger, order({ instrumentId: METR }), 'FILLED', '232.00');

    expect(ledger.snapshot().prices).toEqual([
      { instrumentId: PAMP, price: '100.00' },
      { instrumentId: METR, price: '232.00' },
    ]);
  });

  it('reports whether each user was seeded and whether it is still trusted', () => {
    const ledger = new ShadowLedger();
    ledger.reseed([1, 2]);
    ledger.seed(ledger.generation, 1, {
      availableCash: '10.00',
      positions: [],
    });

    expect(ledger.snapshot().users).toEqual([
      {
        userId: 1,
        cash: '10.00',
        seeded: true,
        uncertain: false,
        outstanding: 0,
        positions: [],
      },
      {
        userId: 2,
        cash: '0.00',
        seeded: false,
        uncertain: false,
        outstanding: 0,
        positions: [],
      },
    ]);
  });

  it('reports how many orders a user still has in flight', () => {
    const ledger = priced('1000.00');
    const first = ledger.reserve(order({ size: 1 }));
    ledger.reserve(order({ size: 2 }));

    expect(ledger.snapshot().users[0].outstanding).toBe(2);

    ledger.settle(first, { status: 'FILLED', price: '100.00' });

    expect(ledger.snapshot().users[0].outstanding).toBe(1);
  });
});
