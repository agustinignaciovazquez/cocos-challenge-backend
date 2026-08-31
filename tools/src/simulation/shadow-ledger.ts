import { Expectation, OrderStatus, SimOrder } from '../order';

export type ShadowPosition = { instrumentId: number; quantity: number };

export type SeedPortfolio = {
  availableCash: string;
  positions: ShadowPosition[];
};

export type Execution = { status: OrderStatus; price: string };

export type ShadowUserSnapshot = {
  userId: number;
  cash: string;
  seeded: boolean;
  uncertain: boolean;
  // How many of this user's orders are still unsettled. A balance read while any of them
  // is in flight compares a target that may already have applied it against a shadow that
  // has not, so the back-office only compares users that are standing still.
  outstanding: number;
  positions: ShadowPosition[];
};

export type ShadowSnapshot = {
  users: ShadowUserSnapshot[];
  prices: { instrumentId: number; price: string }[];
};

// What one unsettled order is holding against its user's shadow. The generation is the
// ledger's own at the moment of the reserve, and a settlement that no longer matches it
// belongs to a shadow that has since been thrown away.
export type Reservation = {
  generation: number;
  order: SimOrder;
  expectation: Expectation;
  heldCash: number;
  heldShares: number;
};

// Every money value the API sends is a string with exactly two decimals and at most ten
// digits, so scaling it by 100 and rounding lands on the exact centavo.
const toCentavos = (money: string): number => Math.round(Number(money) * 100);
const toMoney = (centavos: number): string => (centavos / 100).toFixed(2);

type ShadowUser = {
  cash: number;
  shares: Map<number, number>;
  heldCash: number;
  heldShares: Map<number, number>;
  outstanding: number;
  seeded: boolean;
  uncertain: boolean;
};

const blank = (): ShadowUser => ({
  cash: 0,
  shares: new Map(),
  heldCash: 0,
  heldShares: new Map(),
  outstanding: 0,
  seeded: false,
  uncertain: false,
});

export class ShadowLedger {
  private readonly users = new Map<number, ShadowUser>();
  private readonly prices = new Map<number, number>();
  private current = 0;

  get generation(): number {
    return this.current;
  }

  // Opening a generation is what makes a reset safe while ticks are still in flight: an
  // order sent against the old shadow settles against a generation that no longer
  // matches, and is dropped rather than applied to the freshly seeded state.
  reseed(userIds: number[]): void {
    this.current++;
    this.users.clear();
    for (const userId of userIds) {
      this.users.set(userId, blank());
    }
  }

  seed(generation: number, userId: number, portfolio: SeedPortfolio): boolean {
    const user = this.users.get(userId);
    if (generation !== this.current || user === undefined) {
      return false;
    }

    user.cash = toCentavos(portfolio.availableCash);
    user.shares = new Map(
      portfolio.positions.map(({ instrumentId, quantity }) => [
        instrumentId,
        quantity,
      ]),
    );
    user.seeded = true;
    // Orders sent before this seed are still owed a settlement, and the balance just read
    // cannot account for them, so the shadow stays untrusted until they have all landed.
    user.uncertain = user.outstanding > 0;
    return true;
  }

  // The challenge's rule for a MARKET order: it executes at the latest close, and it is
  // filled when the cash covers the buy or the held shares cover the sell. What an
  // unsettled order would consume is held aside, because the target serialises a user's
  // placements and the second of two overlapping orders does not get to spend the same
  // pesos as the first.
  reserve(order: SimOrder): Reservation {
    const user = this.users.get(order.userId);
    const price = this.prices.get(order.instrumentId);
    const reservation: Reservation = {
      generation: this.current,
      order,
      expectation: this.expect(user, order, price),
      heldCash: 0,
      heldShares: 0,
    };
    if (user === undefined) {
      return reservation;
    }

    user.outstanding++;
    // Only a fill consumes anything, so only an expected fill holds anything.
    if (reservation.expectation === 'FILLED' && price !== undefined) {
      if (order.side === 'BUY') {
        reservation.heldCash = price * order.size;
        user.heldCash += reservation.heldCash;
      } else {
        reservation.heldShares = order.size;
        this.hold(user, order.instrumentId, order.size);
      }
    }
    return reservation;
  }

  // The API is the source of truth, so the shadow adopts whatever it decided rather than
  // what was expected: a single disagreement is then reported once instead of cascading
  // into every later expectation. A rejected MARKET order still reports the close it was
  // priced at, and those responses are the only place the engine learns a price.
  settle(reservation: Reservation, execution: Execution | undefined): void {
    // A MARKET response reports the close the order was priced at; a LIMIT response reports
    // the price the sender asked for, which says nothing about the market.
    if (execution !== undefined && reservation.order.type === 'MARKET') {
      this.prices.set(
        reservation.order.instrumentId,
        toCentavos(execution.price),
      );
    }

    const user = this.release(reservation);
    if (
      user === undefined ||
      execution === undefined ||
      execution.status !== 'FILLED'
    ) {
      return;
    }

    const { instrumentId, side, size } = reservation.order;
    const direction = side === 'BUY' ? 1 : -1;
    user.cash -= direction * toCentavos(execution.price) * size;
    user.shares.set(
      instrumentId,
      (user.shares.get(instrumentId) ?? 0) + direction * size,
    );
  }

  // No answer at all leaves the target's own state unknown — it can commit an order after
  // the gateway has given up waiting for it. This user's shadow is not evidence of
  // anything until it has been read back from the API, so it holds no expectation and
  // reports no disagreement until then.
  lose(reservation: Reservation): void {
    const user = this.release(reservation);
    if (user !== undefined) {
      user.uncertain = true;
    }
  }

  // Re-reading a portfolio only helps once every order that would change it has landed.
  needsReseed(userId: number): boolean {
    const user = this.users.get(userId);
    return (
      user !== undefined &&
      user.outstanding === 0 &&
      (user.uncertain || !user.seeded)
    );
  }

  snapshot(): ShadowSnapshot {
    return {
      users: [...this.users].map(([userId, user]) => ({
        userId,
        cash: toMoney(user.cash),
        seeded: user.seeded,
        uncertain: user.uncertain,
        outstanding: user.outstanding,
        positions: [...user.shares]
          .filter(([, quantity]) => quantity !== 0)
          .map(([instrumentId, quantity]) => ({ instrumentId, quantity })),
      })),
      prices: [...this.prices].map(([instrumentId, price]) => ({
        instrumentId,
        price: toMoney(price),
      })),
    };
  }

  private expect(
    user: ShadowUser | undefined,
    order: SimOrder,
    price: number | undefined,
  ): Expectation {
    // A LIMIT order rests as NEW or is refused, and neither outcome moves cash or shares:
    // there is nothing for the shadow to predict, and so nothing for it to hold either.
    if (
      order.type === 'LIMIT' ||
      user === undefined ||
      !user.seeded ||
      user.uncertain ||
      price === undefined
    ) {
      return 'UNKNOWN';
    }

    const covered =
      order.side === 'BUY'
        ? user.cash - user.heldCash >= price * order.size
        : (user.shares.get(order.instrumentId) ?? 0) -
            (user.heldShares.get(order.instrumentId) ?? 0) >=
          order.size;
    if (covered) {
      return 'FILLED';
    }
    // The two predictions are not equally safe, and only concurrency shows it. A hold assumes
    // every unsettled order will consume what it reserved, so a cover survives whatever the
    // others turn out to be: the target has at least what the shadow counted. Being short
    // does not survive it — an order that is shed under load, or refused, consumes nothing,
    // and the pesos this order was told it could not have were still there. With anything
    // else in flight the shadow can be sure an order fills, never that it is refused.
    return user.outstanding === 0 ? 'REJECTED' : 'UNKNOWN';
  }

  private release(reservation: Reservation): ShadowUser | undefined {
    const user = this.users.get(reservation.order.userId);
    if (reservation.generation !== this.current || user === undefined) {
      return undefined;
    }

    user.outstanding--;
    user.heldCash -= reservation.heldCash;
    if (reservation.heldShares !== 0) {
      this.hold(user, reservation.order.instrumentId, -reservation.heldShares);
    }
    return user;
  }

  private hold(user: ShadowUser, instrumentId: number, shares: number): void {
    user.heldShares.set(
      instrumentId,
      (user.heldShares.get(instrumentId) ?? 0) + shares,
    );
  }
}
