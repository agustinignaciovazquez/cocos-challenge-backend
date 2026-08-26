import { MAX_INT4 } from '../int4';
import { apiString } from '../money';

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
  amount?: bigint;
  price: bigint;
};

export type Placement = {
  side: Side;
  type: OrderType;
  price?: bigint;
  close: bigint;
  availableCash: bigint;
  heldShares: number;
  size: number;
};

export type Decision = { status: OrderStatus; price: bigint };

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

  // Money is positive here, so the truncation integer division already does is the floor
  // whole shares are counted with.
  const shares = amount! / price;
  if (shares === 0n) {
    throw new OrderRuleError(
      `An amount of ${apiString(amount!)} buys no share at ${apiString(price)}`,
    );
  }
  // Both operands can be in range and the quotient still past what an order can hold.
  if (shares > BigInt(MAX_INT4)) {
    throw new OrderRuleError(
      `An amount of ${apiString(amount!)} buys more than ${MAX_INT4} shares at ${apiString(price)}`,
    );
  }
  return Number(shares);
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
      ? availableCash >= executed * BigInt(size)
      : heldShares >= size;

  const accepted = type === 'MARKET' ? 'FILLED' : 'NEW';
  return { status: covered ? accepted : 'REJECTED', price: executed };
}

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return TRANSITIONS[from].includes(to);
}
