// The vocabulary the back-office speaks. A detector is a small pure function over one
// attempt; what it returns is a finding, and the store stamps the id and the time onto it.

import { Attempt } from '../store/attempts.store';

export type Severity = 'info' | 'warning' | 'critical';

export type Finding = {
  rule: string;
  severity: Severity;
  message: string;
  context: Record<string, unknown>;
};

export type Anomaly = Finding & { id: number; at: string };

export type DetectorConfig = { latencyThresholdMs: number };

// What the back-office knows beyond the row itself when it runs the rules. `quietSince` is
// the moment the harness was last seen generating no load of its own, and null while it is.
export type DetectorContext = DetectorConfig & { quietSince?: number | null };

export type DbOrder = { id: number; status: string; at: string };

// A whole order row as the challenge database holds it, which is what the load engine's
// invariants fold. `price` is the column's exact text, never a float.
export type LedgerRow = {
  id: number;
  userId: number;
  instrumentId: number;
  side: string;
  size: number;
  price: string;
  type: string;
  status: string;
};

// `acknowledged` is true when some attempt carries this order id, so a client did get an
// answer for it — which is what tells a genuinely unanswered row from someone else's.
export type MatchedOrder = DbOrder & { acknowledged: boolean };

// Round one: everything the recorder alone knows about a call.
export type Detector = (
  attempt: Attempt,
  context: DetectorContext,
) => Finding | undefined;

// Round two: what the challenge database says about an order whose answer never arrived.
export type ReconciledDetector = (
  attempt: Attempt,
  matches: MatchedOrder[],
) => Finding | undefined;
