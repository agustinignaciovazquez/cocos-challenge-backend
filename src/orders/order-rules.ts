import { Prisma } from '@prisma/client';

export const SIDES = ['BUY', 'SELL'] as const;
export const ORDER_TYPES = ['MARKET', 'LIMIT'] as const;
export const ORDER_STATUSES = [
  'NEW',
  'FILLED',
  'REJECTED',
  'CANCELLED',
] as const;

export type Side = (typeof SIDES)[number];
export type OrderType = (typeof ORDER_TYPES)[number];
export type OrderStatus = (typeof ORDER_STATUSES)[number];

export class OrderRuleError extends Error {}

export type Sizing = {
  size?: number;
  amount?: Prisma.Decimal;
  price: Prisma.Decimal;
};

export type Placement = {
  side: Side;
  type: OrderType;
  price?: Prisma.Decimal;
  close: Prisma.Decimal;
  availableCash: Prisma.Decimal;
  heldShares: number;
  size: number;
};

export type Decision = { status: OrderStatus; price: Prisma.Decimal };

const TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  NEW: ['CANCELLED'],
  FILLED: [],
  REJECTED: [],
  CANCELLED: [],
};

export function resolveSize({ size, amount, price }: Sizing): number {
  if ((size === undefined) === (amount === undefined)) {
    throw new OrderRuleError('Send exactly one of size or amount');
  }
  if (size !== undefined) {
    return size;
  }

  const shares = amount!.div(price).floor().toNumber();
  if (shares === 0) {
    throw new OrderRuleError(
      `An amount of ${amount!.toFixed(2)} buys no share at ${price.toFixed(2)}`,
    );
  }
  return shares;
}

export function decide({
  side,
  type,
  price,
  close,
  availableCash,
  heldShares,
  size,
}: Placement): Decision {
  const executed = type === 'LIMIT' && price !== undefined ? price : close;
  const covered =
    side === 'BUY'
      ? availableCash.greaterThanOrEqualTo(executed.times(size))
      : heldShares >= size;

  const accepted = type === 'MARKET' ? 'FILLED' : 'NEW';
  return { status: covered ? accepted : 'REJECTED', price: executed };
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
