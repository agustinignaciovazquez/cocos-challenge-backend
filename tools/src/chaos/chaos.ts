// The vocabulary of the chaos engine: what can be injected, and the synthetic rows that put
// an injection into the same history the calls it broke live in.
//
// `api_restart` is out of scope: the harness does not own the API process — the operator runs
// it — and a chaos engine that kills a process it did not start cannot put it back.

import { Attempt } from '../store/attempts.store';

export const CHAOS_MODES = [
  'latency_injection',
  'response_drop',
  'client_retry',
  'db_pause',
] as const;

export type ChaosMode = (typeof CHAOS_MODES)[number];

// One knob per mode. `intensity` reads differently for each — milliseconds for the delay, a
// probability for the two dice, seconds for the pause — because that is what each has to be
// told; one word for it is what keeps every mode the same toggle.
export type ChaosToggle = { enabled: boolean; intensity: number };

export type ChaosConfig = Record<ChaosMode, ChaosToggle>;

export type ChaosCounters = {
  delays: number;
  drops: number;
  retries: number;
  pauses: number;
};

export type ChaosState = {
  modes: ChaosConfig;
  active: ChaosMode[];
  dbPausedUntil: string | null;
  counters: ChaosCounters;
  lastError: string | null;
};

// Rows the harness writes about itself rather than calls it made to the target, which is why
// the rules and the statistics both step over them. The prefix is the whole of that contract.
export const CHAOS_PATH = 'chaos:';

export const isChaosEvent = (attempt: Attempt): boolean =>
  attempt.path.startsWith(CHAOS_PATH);

export const chaosEvent = (
  mode: ChaosMode,
  ok: boolean,
  body: Record<string, unknown>,
  latencyMs = 0,
): Omit<Attempt, 'id'> => ({
  at: new Date().toISOString(),
  method: 'CHAOS',
  path: `${CHAOS_PATH}${mode}`,
  latencyMs,
  status: ok ? 200 : 500,
  ok,
  body,
});

// Only the placement path is dropped and retried. A lost portfolio read teaches nothing, and
// the probe exists to ask one question: what does the target do with an order it was told
// about twice because the client never learned the answer to the first?
export const isOrderPlacement = (method: string, path: string): boolean =>
  method === 'POST' && path.split('?')[0] === '/orders';

// What the probe's retry came back with. Under a key the API honours this is a 200 carrying
// the original order, so both halves are worth recording.
export type RetryOutcome = {
  attemptId: number;
  status: number;
  orderId?: number;
};

// The retry gets an answer of its own, and the row it names has to be nameable: an order id
// nobody recorded reads downstream as a row the target created out of nothing.
export const placedOrderId = (body: unknown): number | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { id } = body as { id?: unknown };
  return typeof id === 'number' ? id : undefined;
};
