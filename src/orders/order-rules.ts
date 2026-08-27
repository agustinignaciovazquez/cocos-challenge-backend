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

  // Whole shares are the floor of amount over price — for positive money, the truncation
  // integer division already does. The bounds are asked of the operands rather than of the
  // quotient: both can be in range with the quotient still past what an order can hold, and
  // a price of 0.00 lands there instead of in a division by zero.
  if (amount! < price) {
    throw new OrderRuleError(
      `An amount of ${apiString(amount!)} buys no share at ${apiString(price)}`,
    );
  }
  if (amount! >= price * (BigInt(MAX_INT4) + 1n)) {
    throw new OrderRuleError(
      `An amount of ${apiString(amount!)} buys more than ${MAX_INT4} shares at ${apiString(price)}`,
    );
  }
  return Number(amount! / price);
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
