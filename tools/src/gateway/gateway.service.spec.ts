import { ChaosService } from '../chaos/chaos.service';
import { AttemptsStore } from '../store/attempts.store';
import { GatewayService } from './gateway.service';

const ORDER = {
  userId: 1,
  instrumentId: 47,
  side: 'BUY',
  size: 10,
  type: 'MARKET',
};

// The alphabet the target's header check accepts, which is what a generated key has to sit
// inside for any of this to be worth sending.
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

type Call = { method: string; path: string; key?: string };

type Init = { method: string; headers: Record<string, string>; body?: string };

// The target with its idempotency contract in it: a placement without a key is refused, and
// a key already spent answers 200 with the order the first request created.
const target = (calls: Call[]): typeof fetch => {
  const stored = new Map<string, { id: number; status: string }>();
  let nextId = 900;

  const answer = (path: string, key?: string): Response => {
    if (path !== '/orders') {
      return new Response(JSON.stringify({ availableCash: '1000.00' }), {
        status: 200,
      });
    }
    if (key === undefined) {
      return new Response(
        JSON.stringify({ message: 'Idempotency-Key is required' }),
        { status: 400 },
      );
    }
    const replayed = stored.get(key);
    if (replayed !== undefined) {
      return new Response(JSON.stringify(replayed), { status: 200 });
    }
    const created = { id: nextId++, status: 'FILLED' };
    stored.set(key, created);
    return new Response(JSON.stringify(created), { status: 201 });
  };

  return ((url: string, init: Init): Promise<Response> => {
    const path = new URL(url).pathname;
    const key = init.headers['Idempotency-Key'];
    calls.push({ method: init.method, path, key });
    return Promise.resolve(answer(path, key));
  }) as unknown as typeof fetch;
};

const build = (): {
  gateway: GatewayService;
  attempts: AttemptsStore;
  chaos: ChaosService;
  calls: Call[];
} => {
  const attempts = new AttemptsStore();
  const chaos = new ChaosService(attempts);
  const calls: Call[] = [];
  global.fetch = target(calls);
  return {
    gateway: new GatewayService(attempts, chaos),
    attempts,
    chaos,
    calls,
  };
};

describe('GatewayService', () => {
  const real = global.fetch;
  afterEach(() => {
    global.fetch = real;
  });

  it('names every placement with a key the target accepts', async () => {
    const { gateway, attempts, calls } = build();

    const result = await gateway.send('POST', '/orders', ORDER);

    expect(result.status).toBe(201);
    expect(calls[0].key).toMatch(KEY);
    expect(attempts.recent(1)[0].idempotencyKey).toBe(calls[0].key);
  });

  // One key per logical order, not per client: two orders that look alike are two orders.
  it('names two placements with two keys', async () => {
    const { gateway, calls } = build();

    await gateway.send('POST', '/orders', ORDER);
    await gateway.send('POST', '/orders', ORDER);

    expect(calls[0].key).not.toBe(calls[1].key);
  });

  it('sends no key on a call that is not a placement', async () => {
    const { gateway, attempts, calls } = build();

    await gateway.send('GET', '/users/1/portfolio');

    expect(calls[0].key).toBeUndefined();
    expect(attempts.recent(1)[0].idempotencyKey).toBeUndefined();
  });

  // The probe is the regression test: a client that never learned the answer re-sends the
  // key it already used, and the target has to hand back the order it already created.
  it('re-sends the dropped placement key and gets the same order back', async () => {
    const { gateway, attempts, chaos, calls } = build();
    chaos.configure({ mode: 'response_drop', enabled: true, intensity: 1 });
    chaos.configure({ mode: 'client_retry', enabled: true, intensity: 1 });

    const lost = await gateway.send('POST', '/orders', ORDER);

    expect(lost.status).toBe(0);
    expect(calls).toHaveLength(2);
    expect(calls[1].key).toBe(calls[0].key);

    const retry = attempts
      .recent(10)
      .find((attempt) => attempt.chaos?.retryOf === lost.attemptId);
    expect(retry).toMatchObject({ status: 200, orderId: 900 });
    expect(retry?.idempotencyKey).toBe(calls[0].key);

    const event = attempts
      .recent(10)
      .find((attempt) => attempt.path === 'chaos:client_retry');
    expect(event?.body).toMatchObject({ status: 200, orderId: 900 });
  });
});
