// The vocabulary of one load run. `RunResult` is the whole record of a run and the only
// thing kept about it — the history persists this object as it stands rather than a
// projection.

export type LoadMode = 'burst' | 'ramp' | 'contention';

export type LoadProfile = {
  mode: LoadMode;
  concurrency: number;
  totalOrders: number;
  users: number[];
  sameInstrument: boolean;
  cancelMix: number;
};

export type InvariantResult = { name: string; pass: boolean; detail: string };

export type Quiesce = {
  waitedMs: number;
  timedOut: boolean;
  outstanding: { userId: number; outstanding: number }[];
};

export type RunPhase = 'placing' | 'quiescing' | 'checking' | 'done' | 'failed';

export type RunResult = {
  runId: string;
  profile: LoadProfile;
  startedAt: string;
  finishedAt: string | null;
  phase: RunPhase;
  sent: number;
  byStatus: Record<string, number>;
  latencyMs: { p50: number; p95: number; max: number; samples: number };
  outcomes: Record<string, number>;
  // The API sheds load with a 503 when a placement gives up waiting its turn: documented
  // behaviour under contention, and the reason it is counted apart from the failures.
  shedding: number;
  // No answer at all. Every one of these is a row the database may hold that no response
  // ever named, which is what the response/DB agreement invariant has to allow for.
  unanswered: number;
  cancels: { requested: number; cancelled: number; conflicted: number };
  quiesce: Quiesce | null;
  invariants: InvariantResult[];
  error: string | null;
};

export const DEFAULT_PROFILE: LoadProfile = {
  mode: 'burst',
  concurrency: 10,
  totalOrders: 200,
  users: [1],
  sameInstrument: true,
  cancelMix: 0.1,
};
