import { isChaosEvent } from '../chaos/chaos';
import { Expectation, OrderStatus } from '../order';
import { Attempt } from '../store/attempts.store';

const MINUTE_MS = 60_000;

export type Summary = {
  window: { attempts: number; from: string | null; to: string | null };
  byStatus: Record<string, number>;
  // The target sheds load with a 503 when a placement gives up waiting its turn: documented
  // behaviour under contention, counted apart from the failures because it is the API
  // working rather than breaking.
  shedding: number;
  // Rows the harness wrote about its own injections. They are not calls to the target, so
  // they are kept out of every figure here and counted on their own.
  chaosEvents: number;
  outcomes: {
    expected: Expectation;
    actual: OrderStatus | null;
    count: number;
  }[];
  latencyMs: { p50: number; p95: number; max: number; samples: number };
  byEndpoint: { endpoint: string; count: number }[];
  throughputLast60s: { attempts: number; perSec: number };
};

// Nearest-rank, so every figure reported is one the harness actually measured rather than
// an interpolation between two calls that never happened.
export const percentile = (values: number[], fraction: number): number => {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(fraction * sorted.length);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
};

// Ids in a path are the row, not the endpoint: without this every portfolio read is its
// own bucket and the per-endpoint counts say nothing.
export const endpointOf = (attempt: Attempt): string =>
  `${attempt.method} ${attempt.path.split('?')[0].replace(/\/\d+/g, '/:id')}`;

const completedAt = (attempt: Attempt): number =>
  Date.parse(attempt.at) + attempt.latencyMs;

export const summarise = (attempts: Attempt[], now: number): Summary => {
  const byStatus: Record<string, number> = {};
  const byEndpoint = new Map<string, number>();
  const outcomes = new Map<
    string,
    { expected: Expectation; actual: OrderStatus | null; count: number }
  >();
  const latencies: number[] = [];
  let from: string | null = null;
  let to: string | null = null;
  let lastMinute = 0;
  let counted = 0;
  let shedding = 0;
  let chaosEvents = 0;

  for (const attempt of attempts) {
    if (isChaosEvent(attempt)) {
      chaosEvents++;
      continue;
    }
    counted++;
    const status = String(attempt.status);
    if (attempt.status === 503) {
      shedding++;
    }
    byStatus[status] = (byStatus[status] ?? 0) + 1;

    const endpoint = endpointOf(attempt);
    byEndpoint.set(endpoint, (byEndpoint.get(endpoint) ?? 0) + 1);

    // A call that never answered contributes a give-up time, not a latency, and would
    // otherwise drag every percentile towards the gateway's timeout.
    if (attempt.status !== 0) {
      latencies.push(attempt.latencyMs);
    }

    if (attempt.expected !== undefined) {
      const actual = attempt.actual ?? null;
      const key = `${attempt.expected}>${String(actual)}`;
      const row = outcomes.get(key) ?? {
        expected: attempt.expected,
        actual,
        count: 0,
      };
      row.count++;
      outcomes.set(key, row);
    }

    if (from === null || attempt.at < from) {
      from = attempt.at;
    }
    if (to === null || attempt.at > to) {
      to = attempt.at;
    }
    if (completedAt(attempt) >= now - MINUTE_MS) {
      lastMinute++;
    }
  }

  return {
    window: { attempts: counted, from, to },
    byStatus,
    shedding,
    chaosEvents,
    outcomes: [...outcomes.values()].sort(
      (a, b) =>
        a.expected.localeCompare(b.expected) ||
        String(a.actual).localeCompare(String(b.actual)),
    ),
    latencyMs: {
      p50: percentile(latencies, 0.5),
      p95: percentile(latencies, 0.95),
      max: percentile(latencies, 1),
      samples: latencies.length,
    },
    byEndpoint: [...byEndpoint]
      .map(([endpoint, count]) => ({ endpoint, count }))
      .sort(
        (a, b) => b.count - a.count || a.endpoint.localeCompare(b.endpoint),
      ),
    throughputLast60s: {
      attempts: lastMinute,
      perSec: Math.round((lastMinute / 60) * 100) / 100,
    },
  };
};
