import { BadRequestException, Logger } from '@nestjs/common';
import { asOrderKey, logicalKey } from '../order';
import { Attempt, AttemptsStore } from '../store/attempts.store';
import {
  chaosEvent,
  isChaosEvent,
  isOrderPlacement,
  placedOrderId,
} from './chaos';
import { ChaosService } from './chaos.service';

const order = {
  userId: 1,
  instrumentId: 47,
  side: 'BUY',
  size: 10,
  type: 'MARKET',
};

// What the probe re-sends is the same body the target already answered for once, so the two
// halves of one probe have to land on one key — and two orders that only look alike must not.
describe('logical-order key', () => {
  it('pairs a retry with the send it repeats', () => {
    expect(logicalKey({ ...order })).toBe(logicalKey({ ...order }));
  });

  it('does not care what order the fields arrived in', () => {
    expect(
      logicalKey({
        type: 'MARKET',
        size: 10,
        side: 'BUY',
        instrumentId: 47,
        userId: 1,
      }),
    ).toBe(logicalKey(order));
  });

  it('separates orders that differ in any field that names one', () => {
    const keys = [
      { ...order, userId: 2 },
      { ...order, instrumentId: 54 },
      { ...order, side: 'SELL' },
      { ...order, size: 11 },
      { ...order, type: 'LIMIT' },
    ].map(logicalKey);

    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).not.toContain(logicalKey(order));
  });

  it('has no key for a body that is not an order', () => {
    expect(logicalKey({ userId: 1 })).toBeUndefined();
    expect(logicalKey(undefined)).toBeUndefined();
    expect(logicalKey('POST /orders')).toBeUndefined();
    expect(asOrderKey({ ...order, size: '10' })).toBeUndefined();
  });

  it('keeps whatever the target was told, extra fields included', () => {
    expect(asOrderKey({ ...order, price: 100 })).toEqual(order);
  });
});

describe('what chaos touches', () => {
  it('is the placement path and nothing else', () => {
    expect(isOrderPlacement('POST', '/orders')).toBe(true);
    expect(isOrderPlacement('POST', '/orders?dry=1')).toBe(true);
    expect(isOrderPlacement('GET', '/orders')).toBe(false);
    expect(isOrderPlacement('POST', '/orders/12/cancel')).toBe(false);
    expect(isOrderPlacement('GET', '/users/1/portfolio')).toBe(false);
  });

  it('reads the id off an answer the probe got and nothing else', () => {
    expect(placedOrderId({ id: 412, status: 'FILLED' })).toBe(412);
    expect(placedOrderId({ message: 'Bad Request' })).toBeUndefined();
    expect(placedOrderId(undefined)).toBeUndefined();
  });
});

describe('ChaosService', () => {
  const build = (): { chaos: ChaosService; attempts: AttemptsStore } => {
    const attempts = new AttemptsStore();
    return { chaos: new ChaosService(attempts), attempts };
  };

  // A harness that starts breaking things on boot cannot be trusted to say what the target
  // does on its own.
  it('injects nothing until it is asked to', async () => {
    const { chaos } = build();

    expect(chaos.state().active).toEqual([]);
    expect(await chaos.delay()).toBe(0);
    expect(chaos.dropsResponse('POST', '/orders')).toBe(false);
    expect(chaos.retriesOrder('POST', '/orders')).toBe(false);
  });

  it('drops every placement at full intensity and nothing else ever', () => {
    const { chaos } = build();
    chaos.configure({ mode: 'response_drop', enabled: true, intensity: 1 });

    expect(chaos.state().active).toEqual(['response_drop']);
    expect(chaos.dropsResponse('POST', '/orders')).toBe(true);
    expect(chaos.dropsResponse('GET', '/users/1/portfolio')).toBe(false);
  });

  it('patches one knob without moving the other', () => {
    const { chaos } = build();
    chaos.configure({ mode: 'latency_injection', intensity: 900 });

    expect(chaos.state().modes.latency_injection).toEqual({
      enabled: false,
      intensity: 900,
    });

    chaos.configure({ mode: 'latency_injection', enabled: true });

    expect(chaos.state().modes.latency_injection).toEqual({
      enabled: true,
      intensity: 900,
    });
  });

  // Every mode reads its intensity in its own unit, so each refuses what cannot be one:
  // a probability above one is a typo, not a certainty.
  it('refuses an intensity the mode cannot mean', () => {
    const { chaos } = build();

    expect(() =>
      chaos.configure({ mode: 'response_drop', intensity: 20 }),
    ).toThrow(BadRequestException);
    expect(() => chaos.configure({ mode: 'db_pause', intensity: 600 })).toThrow(
      BadRequestException,
    );
    expect(chaos.state().modes.response_drop.intensity).toBe(0.2);
  });

  it('writes every change into the history it shares with the calls', () => {
    const { chaos, attempts } = build();
    chaos.configure({ mode: 'client_retry', enabled: true });
    chaos.droppedResponse(3, 201);
    chaos.retriedOrder(3, order, { attemptId: 4, status: 200, orderId: 91 });

    expect(attempts.recent(10).map((row) => row.path)).toEqual([
      'chaos:client_retry',
      'chaos:response_drop',
      'chaos:client_retry',
    ]);
    expect(attempts.recent(1)[0].body).toEqual({
      of: 3,
      retry: 4,
      order: '1/47/BUY/10/MARKET',
      status: 200,
      orderId: 91,
    });
    expect(chaos.state().counters).toMatchObject({ drops: 1, retries: 1 });
  });

  // A pause is the one injection that can outlive the harness, so what the engine believes
  // about the database has to be what the database is actually doing.
  describe('db_pause', () => {
    // The engine with docker taken out of it, and a note of what it would have run.
    class Composed extends ChaosService {
      readonly calls: string[] = [];

      constructor(private readonly refuses?: 'pause' | 'unpause') {
        super(new AttemptsStore());
      }

      protected compose(action: 'pause' | 'unpause'): Promise<unknown> {
        this.calls.push(action);
        return action === this.refuses
          ? Promise.reject(new Error(`${action} refused`))
          : Promise.resolve(undefined);
      }
    }

    // The pause itself is zero seconds long: what is under test is the bookkeeping around
    // the two compose calls, not the wait between them.
    const pause = async (chaos: ChaosService): Promise<void> => {
      chaos.configure({ mode: 'db_pause', enabled: true, intensity: 0 });
      await new Promise((done) => setTimeout(done, 5));
    };

    beforeEach(() => {
      Logger.overrideLogger(false);
    });

    afterEach(() => {
      Logger.overrideLogger(true);
    });

    it('pauses, comes back, and switches itself off', async () => {
      const chaos = new Composed();
      await pause(chaos);

      expect(chaos.calls).toEqual(['pause', 'unpause']);
      expect(chaos.state().dbPausedUntil).toBeNull();
      expect(chaos.state().modes.db_pause.enabled).toBe(false);
    });

    // The database is still down. Clearing the mark here would report a paused database as
    // running and disarm the one thing left that would have put it back.
    it('keeps the mark when the unpause fails, so shutdown tries again', async () => {
      const chaos = new Composed('unpause');
      await pause(chaos);

      expect(chaos.state().dbPausedUntil).not.toBeNull();
      expect(chaos.state().lastError).toBe('unpause refused');

      await chaos.onModuleDestroy();

      expect(chaos.calls).toEqual(['pause', 'unpause', 'unpause']);
    });

    // Nothing was paused, so nothing is stuck: a mark left standing here would claim an
    // outage that never happened and refuse every pause after it.
    it('claims no pause when the pause itself was refused', async () => {
      const chaos = new Composed('pause');
      await pause(chaos);

      expect(chaos.calls).toEqual(['pause']);
      expect(chaos.state().dbPausedUntil).toBeNull();

      await chaos.onModuleDestroy();

      expect(chaos.calls).toEqual(['pause']);
    });
  });
});

// The harness's own notes live in the same history the calls do, and every reader of that
// history has to be able to step over them.
describe('chaos events', () => {
  it('records what ran under a path no target endpoint can collide with', () => {
    const event = chaosEvent('db_pause', true, { seconds: 5 }, 5_012);

    expect(event).toMatchObject({
      method: 'CHAOS',
      path: 'chaos:db_pause',
      status: 200,
      ok: true,
      latencyMs: 5_012,
      body: { seconds: 5 },
    });
    expect(isChaosEvent({ ...event, id: 1 })).toBe(true);
  });

  it('marks an injection that could not be carried out', () => {
    expect(
      chaosEvent('db_pause', false, { message: 'no such service' }),
    ).toMatchObject({
      status: 500,
      ok: false,
    });
  });

  it('leaves a real call to the target alone', () => {
    const call: Attempt = {
      id: 1,
      at: new Date().toISOString(),
      method: 'POST',
      path: '/orders',
      latencyMs: 4,
      status: 201,
      ok: true,
    };

    expect(isChaosEvent(call)).toBe(false);
  });
});
