import { useEffect, useState } from 'react';

// Everything the browser asks for goes to the sim: trading through its recording /api proxy,
// the harness surfaces directly. The vite dev proxy puts both on :3001.
export const POLL_MS = 2000;

export class ApiError extends Error {
  readonly status: number;
  readonly messages: string[];

  constructor(status: number, messages: string[]) {
    super(messages.join(' · '));
    this.status = status;
    this.messages = messages;
  }
}

// Nest answers a rejected order with a single string and a rejected body with a list of
// them; both are the sentence the trader needs, so both come back as a list.
const messagesOf = (body: unknown, status: number): string[] => {
  const message = (body as { message?: unknown } | undefined)?.message;
  if (typeof message === 'string') {
    return [message];
  }
  if (Array.isArray(message)) {
    return message.map(String);
  }
  return [`The request failed with status ${status}.`];
};

const request = async <T>(path: string, init?: RequestInit): Promise<T> => {
  const response = await fetch(path, init);
  const text = await response.text();
  const body: unknown = text === '' ? undefined : JSON.parse(text);
  if (!response.ok) {
    throw new ApiError(response.status, messagesOf(body, response.status));
  }
  return body as T;
};

export const get = <T>(path: string): Promise<T> => request<T>(path);

export const send = <T>(
  method: 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<T> =>
  request<T>(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

export const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export type Poll<T> = { data?: T; error: string | null; reload: () => void };

// One request at a time: the next is scheduled when the last one lands, so a slow sim (or an
// injected delay) can never stack up a queue of polls behind it. A null path polls nothing,
// which is how a caller waits for the id of the thing it wants to watch.
export function usePoll<T>(path: string | null, everyMs: number = POLL_MS): Poll<T> {
  const [state, setState] = useState<{ data?: T; error: string | null }>({ error: null });
  const [nonce, setNonce] = useState(0);

  // What is held belongs to the path it came from. When the caller switches paths — another
  // user's portfolio, another run — the held answer is not this path's answer, so it is
  // dropped here, in the render that changed the path rather than in an effect after it: the
  // caller falls back to its loading state and can never label one account's money with
  // another account's name, not even for a frame. A held error goes with it, so a failing
  // first poll on the new path is reported as this path's failure and not the old one's.
  // A reload() is not a path change and leaves what is on screen alone.
  // The path this state belongs to is itself state, not a ref: a ref mutated during render
  // survives the render React throws away, so the second pass would see the switch already
  // handled and commit the previous path's data after all.
  const [held, setHeld] = useState(path);
  if (held !== path) {
    setHeld(path);
    setState({ error: null });
  }

  useEffect(() => {
    if (path === null) {
      return;
    }
    let live = true;
    let timer = 0;
    const tick = async (): Promise<void> => {
      try {
        const data = await get<T>(path);
        if (live) {
          setState({ data, error: null });
        }
      } catch (error) {
        if (live) {
          setState((previous) => ({ ...previous, error: describe(error) }));
        }
      }
      if (live) {
        timer = window.setTimeout(() => void tick(), everyMs);
      }
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [path, everyMs, nonce]);

  return { ...state, reload: () => setNonce((n) => n + 1) };
}

// Money arrives as exact 2-decimal text and stays text: grouped for reading in the Argentine
// convention, never parsed. A float would round the cents the API was careful about.
export const money = (value: string): string => {
  const [whole, cents = '00'] = value.split('.');
  const sign = whole.startsWith('-') ? '-' : '';
  const digits = sign === '' ? whole : whole.slice(1);
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
};

// Pesos group the Argentine way above; the harness's own counts group the English way, or a
// millisecond count like `1.397 ms` reads as a decimal in the panel's English copy.
export const count = (value: number): string => value.toLocaleString('en-US');

export const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('es-AR', { hour12: false });

export const stamp = (iso: string): string =>
  new Date(iso).toLocaleString('es-AR', { hour12: false });

/* ---- challenge API, through the sim's /api proxy ---- */

export type Position = {
  instrumentId: number;
  ticker: string;
  name: string;
  quantity: number;
  marketValue: string;
  // A position the user is net short has no cost basis to average and so no return to
  // measure against one: the API answers NULL for both rather than inventing a zero.
  avgCost: string | null;
  totalReturnPct: string | null;
};

export type Portfolio = {
  totalValue: string;
  availableCash: string;
  positions: Position[];
};

export type Instrument = { id: number; ticker: string; name: string; type: string };

export type Order = {
  id: number;
  instrumentId: number;
  userId: number;
  side: 'BUY' | 'SELL';
  size: number;
  price: string;
  type: string;
  status: string;
  datetime: string;
};

/* ---- the harness ---- */

export type Attempt = {
  id: number;
  at: string;
  method: string;
  path: string;
  latencyMs: number;
  status: number;
  ok: boolean;
};

export type SimulationConfig = {
  ratePerSec: number;
  users: number[];
  buyRatio: number;
  sizeMin: number;
  sizeMax: number;
  running: boolean;
};

export type SimulationState = {
  config: SimulationConfig;
  counters: {
    sent: number;
    filled: number;
    rejected: number;
    failed: number;
    attempts: number;
  };
  shadow: {
    users: {
      userId: number;
      cash: string;
      seeded: boolean;
      uncertain: boolean;
      outstanding: number;
    }[];
  };
};

export type Stats = {
  window: { attempts: number; from: string | null; to: string | null };
  byStatus: Record<string, number>;
  shedding: number;
  chaosEvents: number;
  // `actual` is null for a placement that never came back as an order — a shed 503, a
  // refused 400, a dropped call: the rules had an expectation, the API never stated an
  // outcome to compare it against.
  outcomes: { expected: string; actual: string | null; count: number }[];
  latencyMs: { p50: number; p95: number; max: number; samples: number };
  byEndpoint: { endpoint: string; count: number }[];
  throughputLast60s: { attempts: number; perSec: number };
  config: { latencyThresholdMs: number };
  anomalies: number;
  reconciler: { pending: number; lastRunAt: string | null; lastError: string | null };
};

export type Severity = 'info' | 'warning' | 'critical';

export type Anomaly = {
  id: number;
  at: string;
  rule: string;
  severity: Severity;
  message: string;
  context: Record<string, unknown>;
};

export const CHAOS_MODES = [
  'latency_injection',
  'response_drop',
  'client_retry',
  'db_pause',
] as const;

export type ChaosMode = (typeof CHAOS_MODES)[number];

export type ChaosState = {
  modes: Record<ChaosMode, { enabled: boolean; intensity: number }>;
  active: ChaosMode[];
  dbPausedUntil: string | null;
  counters: { delays: number; drops: number; retries: number; pauses: number };
  lastError: string | null;
};

export type LoadProfile = {
  mode: 'burst' | 'ramp' | 'contention';
  concurrency: number;
  totalOrders: number;
  users: number[];
  sameInstrument: boolean;
  cancelMix: number;
};

export type Invariant = { name: string; pass: boolean; detail: string };

export type RunResult = {
  runId: string;
  profile: LoadProfile;
  startedAt: string;
  finishedAt: string | null;
  phase: 'placing' | 'quiescing' | 'checking' | 'done' | 'failed';
  sent: number;
  byStatus: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number; samples: number };
  outcomes: Record<string, number>;
  shedding: number;
  unanswered: number;
  cancels: { requested: number; cancelled: number; conflicted: number };
  quiesce: {
    waitedMs: number;
    timedOut: boolean;
    outstanding: { userId: number; outstanding: number }[];
  } | null;
  invariants: Invariant[];
  error: string | null;
};

export type LoadState = {
  running: boolean;
  profile: LoadProfile;
  current: RunResult | null;
  runs: string[];
};

export type RunManifest = {
  runId: string;
  mode: string;
  startedAt: string;
  finishedAt: string | null;
  config: Record<string, unknown>;
  chaos: { atStart: ChaosState['modes']; atEnd: ChaosState['modes'] | null };
  summary: Record<string, unknown> | null;
};
