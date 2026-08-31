import { Attempt } from '../store/attempts.store';
import { endpointOf, percentile, summarise } from './stats';

const NOW = Date.parse('2026-08-26T12:00:00.000Z');

const at = (secondsAgo: number): string =>
  new Date(NOW - secondsAgo * 1000).toISOString();

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 1,
  at: at(10),
  method: 'POST',
  path: '/orders',
  latencyMs: 10,
  status: 201,
  ok: true,
  ...over,
});

describe('percentile', () => {
  it('is zero with nothing measured', () => {
    expect(percentile([], 0.5)).toBe(0);
  });

  it('is the only sample when there is one', () => {
    expect(percentile([42], 0.5)).toBe(42);
    expect(percentile([42], 0.95)).toBe(42);
  });

  // Nearest-rank: p50 of ten samples is the fifth, not the mean of the fifth and sixth.
  it('takes the nearest rank rather than interpolating', () => {
    const ten = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

    expect(percentile(ten, 0.5)).toBe(5);
    expect(percentile(ten, 0.95)).toBe(10);
    expect(percentile(ten, 1)).toBe(10);
  });

  it('does not care what order the samples arrive in', () => {
    expect(percentile([9, 1, 5, 3, 7], 0.5)).toBe(5);
  });

  it('leaves the caller array untouched', () => {
    const values = [3, 1, 2];
    percentile(values, 0.5);

    expect(values).toEqual([3, 1, 2]);
  });

  it('never falls off either end of the sample', () => {
    expect(percentile([1, 2, 3], 0)).toBe(1);
    expect(percentile([1, 2, 3], 2)).toBe(3);
  });
});

describe('endpointOf', () => {
  it('drops the query string and folds ids into one bucket', () => {
    expect(
      endpointOf(attempt({ method: 'GET', path: '/users/17/portfolio' })),
    ).toBe('GET /users/:id/portfolio');
    expect(
      endpointOf(attempt({ method: 'GET', path: '/instruments?q=pam' })),
    ).toBe('GET /instruments');
  });
});

describe('summarise', () => {
  it('reports an empty window without dividing by nothing', () => {
    expect(summarise([], NOW)).toEqual({
      window: { attempts: 0, from: null, to: null },
      byStatus: {},
      shedding: 0,
      chaosEvents: 0,
      outcomes: [],
      latencyMs: { p50: 0, p95: 0, max: 0, samples: 0 },
      byEndpoint: [],
      throughputLast60s: { attempts: 0, perSec: 0 },
    });
  });

  it('totals the calls by status, the recorder mark included', () => {
    const summary = summarise(
      [
        attempt({ id: 1, status: 201 }),
        attempt({ id: 2, status: 201 }),
        attempt({ id: 3, status: 404, ok: false }),
        attempt({ id: 4, status: 0, ok: false }),
      ],
      NOW,
    );

    expect(summary.byStatus).toEqual({ '0': 1, '201': 2, '404': 1 });
    expect(summary.window.attempts).toBe(4);
  });

  it('counts each endpoint once however its ids differ', () => {
    expect(
      summarise(
        [
          attempt({ id: 1, method: 'GET', path: '/users/1/portfolio' }),
          attempt({ id: 2, method: 'GET', path: '/users/2/portfolio' }),
          attempt({ id: 3 }),
        ],
        NOW,
      ).byEndpoint,
    ).toEqual([
      { endpoint: 'GET /users/:id/portfolio', count: 2 },
      { endpoint: 'POST /orders', count: 1 },
    ]);
  });

  it('builds the expected-against-actual matrix over placed orders only', () => {
    expect(
      summarise(
        [
          attempt({ id: 1, expected: 'FILLED', actual: 'FILLED' }),
          attempt({ id: 2, expected: 'FILLED', actual: 'FILLED' }),
          attempt({ id: 3, expected: 'REJECTED', actual: 'FILLED' }),
          attempt({ id: 4, expected: 'UNKNOWN', status: 0, ok: false }),
          attempt({ id: 5, method: 'GET', path: '/instruments' }),
        ],
        NOW,
      ).outcomes,
    ).toEqual([
      { expected: 'FILLED', actual: 'FILLED', count: 2 },
      { expected: 'REJECTED', actual: 'FILLED', count: 1 },
      { expected: 'UNKNOWN', actual: null, count: 1 },
    ]);
  });

  // A timeout measures how long the gateway waited before giving up, not how fast the
  // target answers, and it would drag every percentile towards the timeout.
  it('measures latency over the calls that actually answered', () => {
    expect(
      summarise(
        [
          attempt({ id: 1, latencyMs: 10 }),
          attempt({ id: 2, latencyMs: 20 }),
          attempt({ id: 3, latencyMs: 30 }),
          attempt({ id: 4, latencyMs: 10_000, status: 0, ok: false }),
        ],
        NOW,
      ).latencyMs,
    ).toEqual({ p50: 20, p95: 30, max: 30, samples: 3 });
  });

  it('counts throughput over the last sixty seconds only', () => {
    expect(
      summarise(
        [
          attempt({ id: 1, at: at(5) }),
          attempt({ id: 2, at: at(59) }),
          attempt({ id: 3, at: at(61) }),
          attempt({ id: 4, at: at(600) }),
        ],
        NOW,
      ).throughputLast60s,
    ).toEqual({ attempts: 2, perSec: 0.03 });
  });

  it('reports the window it summarised whatever order it was handed', () => {
    expect(
      summarise(
        [attempt({ id: 2, at: at(5) }), attempt({ id: 1, at: at(90) })],
        NOW,
      ).window,
    ).toEqual({ attempts: 2, from: at(90), to: at(5) });
  });
});
