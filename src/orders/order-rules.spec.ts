import { Prisma } from '@prisma/client';
import {
  canTransition,
  decide,
  OrderRuleError,
  Placement,
  resolveSize,
} from './order-rules';

const money = (value: string): Prisma.Decimal => new Prisma.Decimal(value);

const outcome = (placement: Placement): string => {
  const decision = decide(placement);
  return `${decision.status} @ ${decision.price.toFixed(2)}`;
};

const buy: Placement = {
  side: 'BUY',
  type: 'MARKET',
  close: money('925.85'),
  availableCash: money('9258.50'),
  heldShares: 0,
  size: 10,
};

const sell: Placement = { ...buy, side: 'SELL', heldShares: 500 };

describe('resolveSize', () => {
  it('takes the requested size as is', () => {
    expect(resolveSize({ size: 10, price: money('925.85') })).toBe(10);
  });

  it('floors an amount into whole shares at the given price', () => {
    expect(
      resolveSize({ amount: money('10000'), price: money('925.85') }),
    ).toBe(10);
  });

  it('rejects an amount that does not buy a single share', () => {
    expect(() =>
      resolveSize({ amount: money('100'), price: money('925.85') }),
    ).toThrow(OrderRuleError);
  });

  it('rejects an amount that buys more shares than an order can hold', () => {
    expect(() =>
      resolveSize({ amount: money('99999999.99'), price: money('0.01') }),
    ).toThrow(OrderRuleError);
  });

  it('rejects a request carrying both a size and an amount', () => {
    expect(() =>
      resolveSize({ size: 10, amount: money('10000'), price: money('925.85') }),
    ).toThrow(OrderRuleError);
  });

  it('rejects a request carrying neither a size nor an amount', () => {
    expect(() => resolveSize({ price: money('925.85') })).toThrow(
      OrderRuleError,
    );
  });
});

describe('decide', () => {
  it('fills a market buy at the latest close', () => {
    expect(outcome(buy)).toBe('FILLED @ 925.85');
  });

  it('parks a limit buy at its limit price', () => {
    expect(outcome({ ...buy, type: 'LIMIT', price: money('900') })).toBe(
      'NEW @ 900.00',
    );
  });

  it('accepts a buy that spends the cash down to zero', () => {
    expect(outcome({ ...buy, availableCash: money('9258.50') })).toBe(
      'FILLED @ 925.85',
    );
  });

  it('rejects a market buy beyond the available cash', () => {
    expect(outcome({ ...buy, availableCash: money('9258.49') })).toBe(
      'REJECTED @ 925.85',
    );
  });

  it('rejects a limit buy the cash cannot cover at the limit price', () => {
    expect(
      outcome({
        ...buy,
        type: 'LIMIT',
        price: money('1000'),
        availableCash: money('9999.99'),
      }),
    ).toBe('REJECTED @ 1000.00');
  });

  it('parks a limit sell at its limit price', () => {
    expect(
      outcome({ ...sell, type: 'LIMIT', price: money('1000'), size: 500 }),
    ).toBe('NEW @ 1000.00');
  });

  it('fills a market sell covered by the held shares', () => {
    expect(outcome({ ...sell, size: 500 })).toBe('FILLED @ 925.85');
  });

  it('rejects a sell beyond the held shares', () => {
    expect(outcome({ ...sell, size: 501 })).toBe('REJECTED @ 925.85');
  });

  it('rejects a sell of an instrument the user does not hold', () => {
    expect(outcome({ ...sell, heldShares: 0 })).toBe('REJECTED @ 925.85');
  });

  it('ignores the held shares when buying and the cash when selling', () => {
    expect(outcome({ ...buy, heldShares: 0 })).toBe('FILLED @ 925.85');
    expect(outcome({ ...sell, availableCash: money('0') })).toBe(
      'FILLED @ 925.85',
    );
  });
});

describe('canTransition', () => {
  it('allows cancelling an open order', () => {
    expect(canTransition('NEW', 'CANCELLED')).toBe(true);
  });

  it('refuses every other transition', () => {
    expect(canTransition('FILLED', 'CANCELLED')).toBe(false);
    expect(canTransition('REJECTED', 'CANCELLED')).toBe(false);
    expect(canTransition('CANCELLED', 'CANCELLED')).toBe(false);
    expect(canTransition('NEW', 'FILLED')).toBe(false);
    expect(canTransition('NEW', 'REJECTED')).toBe(false);
    expect(canTransition('NEW', 'NEW')).toBe(false);
  });
});
