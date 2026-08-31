// The vocabulary the target API speaks, shared by the attempts store, the shadow ledger
// and the engine. The sim only ever sends MARKET orders, so an expectation is a fill, a
// rejection, or "no opinion" while the instrument's price is still unknown.

export type Side = 'BUY' | 'SELL';

export type OrderStatus = 'NEW' | 'FILLED' | 'REJECTED' | 'CANCELLED';

export type Expectation = 'FILLED' | 'REJECTED' | 'UNKNOWN';

type Placement = {
  userId: number;
  instrumentId: number;
  side: Side;
  size: number;
};

export type MarketOrder = Placement & { type: 'MARKET' };

// What one order looked like on the wire, checked field by field before anything is read off
// a body the target may never have accepted.
export type OrderKey = {
  userId: number;
  instrumentId: number;
  side: string;
  size: number;
  type: string;
};

export const asOrderKey = (sent: unknown): OrderKey | undefined => {
  if (typeof sent !== 'object' || sent === null) {
    return undefined;
  }
  const { userId, instrumentId, side, size, type } = sent as Partial<OrderKey>;
  return typeof userId === 'number' &&
    typeof instrumentId === 'number' &&
    typeof side === 'string' &&
    typeof size === 'number' &&
    typeof type === 'string'
    ? { userId, instrumentId, side, size, type }
    : undefined;
};

// The shape of one logical order, for reading history: it names what a retry re-sent. Order
// identity itself is the idempotency key the target now carries, never this.
export const logicalKey = (sent: unknown): string | undefined => {
  const key = asOrderKey(sent);
  return key === undefined
    ? undefined
    : `${key.userId}/${key.instrumentId}/${key.side}/${key.size}/${key.type}`;
};

// The load engine's one exception to MARKET-only, and only to create a cancellable row:
// the API rests a covered LIMIT order as NEW and refuses it otherwise, so neither outcome
// moves cash or shares and the shadow holds nothing against it.
export type LimitOrder = Placement & { type: 'LIMIT'; price: string };

export type SimOrder = MarketOrder | LimitOrder;
