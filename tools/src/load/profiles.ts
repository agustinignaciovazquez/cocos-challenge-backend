import { LimitOrder, MarketOrder } from '../order';
import { TRADABLE_INSTRUMENTS } from '../simulation/simulation.service';
import { LoadProfile } from './run';

// BMA. The seed leaves user 1 ten shares short in it and nothing else, so it is the one
// instrument where a broken no-oversell would actually show against a known floor.
export const HOT_INSTRUMENT = 31;

// A resting buy far below the market: covered while the user has a peso, refused when they
// have none, and never filled — which is exactly the cancellable row a cancel needs.
const LIMIT_PRICE = '1.00';

// Sizes cycle rather than randomise. The race is made by the concurrency, not by the
// payload, and a plan that is a pure function of its profile is one a failing run can be
// replayed from.
const SIZES = [1, 2, 3];

// A cancel carries the resting order it would have created, because the first wave of a run
// has nothing to cancel yet: the step then places that order instead, which is what fills
// the queue for the cancels behind it. Either way one step is one request.
export type Step =
  | { kind: 'place'; order: MarketOrder | LimitOrder }
  | { kind: 'cancel'; fallback: LimitOrder };

export type Wave = Step[];

const instrumentAt = (profile: LoadProfile, index: number): number =>
  profile.sameInstrument
    ? HOT_INSTRUMENT
    : TRADABLE_INSTRUMENTS[index % TRADABLE_INSTRUMENTS.length];

const userAt = (profile: LoadProfile, index: number): number =>
  profile.mode === 'contention'
    ? profile.users[0]
    : profile.users[index % profile.users.length];

// Cancels are interleaved on a fixed period rather than sprinkled at random, so a profile
// says how much of the traffic is the cancel dance and the plan says exactly where it is.
// A period of one would leave no room for the cancel itself, which is why the DTO caps the
// mix at a half.
const stepAt = (profile: LoadProfile, index: number): Step => {
  const cancelling = profile.mode === 'contention' && profile.cancelMix > 0;
  const period = cancelling ? Math.round(1 / profile.cancelMix) : 0;

  const placement = {
    userId: userAt(profile, index),
    instrumentId: instrumentAt(profile, index),
    size: SIZES[index % SIZES.length],
  };
  // A resting order has to be one the target will accept, and a BUY at a peso is covered
  // whenever the user has any cash at all; a SELL would need shares the contention profile
  // has usually just spent.
  const resting: LimitOrder = {
    ...placement,
    side: 'BUY',
    size: 1,
    type: 'LIMIT',
    price: LIMIT_PRICE,
  };

  if (period < 2) {
    return { kind: 'place', order: market(placement, index) };
  }
  if (index % period === 0) {
    return { kind: 'place', order: resting };
  }
  return index % period === 1
    ? { kind: 'cancel', fallback: resting }
    : { kind: 'place', order: market(placement, index) };
};

const market = (
  placement: Omit<MarketOrder, 'side' | 'type'>,
  index: number,
): MarketOrder => ({
  ...placement,
  side: index % 2 === 0 ? 'BUY' : 'SELL',
  type: 'MARKET',
});

// Burst and contention fire full waves from the first one; a ramp opens at one so the target
// sees the pressure arrive rather than land. It climbs over the first half of the run and
// holds at the top for the second — a climb spread over the whole run would have its last
// waves cut short by the orders it has left, and would never actually reach the concurrency
// the profile asked for.
const RAMP_OVER = 0.5;

const concurrencyAt = (profile: LoadProfile, sent: number): number => {
  if (profile.mode !== 'ramp') {
    return profile.concurrency;
  }
  const climbed = Math.min(1, sent / (profile.totalOrders * RAMP_OVER));
  return 1 + Math.floor((profile.concurrency - 1) * climbed);
};

export const planWaves = (profile: LoadProfile): Wave[] => {
  const waves: Wave[] = [];
  let sent = 0;

  while (sent < profile.totalOrders) {
    const width = Math.min(
      concurrencyAt(profile, sent),
      profile.totalOrders - sent,
    );
    waves.push(
      Array.from({ length: width }, (_, at) => stepAt(profile, sent + at)),
    );
    sent += width;
  }
  return waves;
};
