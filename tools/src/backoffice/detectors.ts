import { duplicateExecution } from '../chaos/rules';
import { asOrderKey } from '../order';
import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { Attempt } from '../store/attempts.store';
import { Detector, Finding, ReconciledDetector } from './anomaly';

// The target's own ceiling for storing a row, measured from the moment its handler starts:
// Prisma waits up to 5s for a database connection (maxWait) and then runs the placement
// transaction for up to 10s (timeout), and the row is stamped inside that transaction.
// Past this the transaction is rolled back and no row is ever written.
const TARGET_CEILING_MS = 15_000;

// Transit and clock rounding on top of the ceiling. The advisory-lock queue needs no
// allowance of its own: a placement waits its turn inside the transaction.
const MATCH_SLACK_MS = 1_000;

// Measured from the send, not from the moment the gateway gave up waiting: how long the
// client was prepared to wait says nothing about how long the target takes.
export const LATE_COMMIT_MS = TARGET_CEILING_MS + MATCH_SLACK_MS;

const route = (path: string): string => path.split('?')[0];

// A ring of 500 anomalies must not be able to hold 500 error pages.
const BODY_LIMIT = 500;

const brief = (body: unknown): unknown => {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return text === undefined || text.length <= BODY_LIMIT
    ? body
    : `${text.slice(0, BODY_LIMIT)}… (${text.length} characters)`;
};

const transportMessage = (body: unknown): string => {
  if (typeof body === 'object' && body !== null) {
    const { message } = body as { message?: unknown };
    if (typeof message === 'string') {
      return message;
    }
  }
  return 'no answer';
};

// A call that never came back is a failure, not a slow answer: http_5xx owns it, and
// reporting the gateway's own give-up time as a latency breach would double every outage.
export const latencyHigh: Detector = (attempt, { latencyThresholdMs }) =>
  attempt.status !== 0 && attempt.latencyMs > latencyThresholdMs
    ? {
        rule: 'latency_high',
        severity: 'warning',
        message: `${attempt.method} ${attempt.path} answered in ${attempt.latencyMs}ms, past the ${latencyThresholdMs}ms threshold`,
        context: { latencyMs: attempt.latencyMs, latencyThresholdMs },
      }
    : undefined;

// Status 0 is the recorder's mark for an answer that never came — a transport failure or
// the gateway's own timeout — and it fails the caller exactly as a 500 does.
//
// A 503 is not a failure at all: it is the target's documented load-shedding, a placement
// that waited longer for its turn than its transaction is allowed to live being rolled back
// and refused. Grading thousands of those critical buries every real fault under a run the
// API survived correctly, so the shedding gets a rule of its own instead.
export const http5xx: Detector = (attempt) => {
  if (
    attempt.status === 503 ||
    (attempt.status !== 0 && attempt.status < 500)
  ) {
    return undefined;
  }
  return {
    rule: 'http_5xx',
    severity: 'critical',
    message:
      attempt.status === 0
        ? `${attempt.method} ${attempt.path} never answered: ${transportMessage(attempt.body)}`
        : `${attempt.method} ${attempt.path} answered ${attempt.status}`,
    context: { status: attempt.status, body: brief(attempt.body) },
  };
};

// Shedding is only expected while something is asking for more than the target can serve.
// The mark is when the harness was last seen idle rather than when it went idle, so this
// can only ever be late to call the target quiet — never early, which is the direction that
// would report a run's own shedding as the API refusing traffic it should have served.
export const unexpectedShedding: Detector = (attempt, { quietSince }) =>
  attempt.status === 503 &&
  quietSince !== undefined &&
  quietSince !== null &&
  Date.parse(attempt.at) >= quietSince
    ? {
        rule: 'unexpected_shedding',
        severity: 'warning',
        message: `${attempt.method} ${attempt.path} was shed with a 503 while neither the simulation nor a load run was driving the target`,
        context: {
          status: attempt.status,
          quietSince: new Date(quietSince).toISOString(),
        },
      }
    : undefined;

// Both sides have to be known. An UNKNOWN expectation is the engine saying it has no
// opinion — no price learned yet, or a shadow it stopped trusting — not a disagreement.
export const unexpectedStatus: Detector = (attempt) =>
  attempt.expected !== undefined &&
  attempt.expected !== 'UNKNOWN' &&
  attempt.actual !== undefined &&
  attempt.expected !== attempt.actual
    ? {
        rule: 'unexpected_status',
        severity: 'critical',
        message: `The rules say this order was ${attempt.expected}, the API answered ${attempt.actual}`,
        context: {
          expected: attempt.expected,
          actual: attempt.actual,
          orderId: attempt.orderId,
          sent: attempt.sent,
        },
      }
    : undefined;

// The key found this attempt's own order, so absence is the whole test. A row some attempt
// did get an answer for is that order replayed by the retry: recovered, not unaccounted for.
export const lostOrder: ReconciledDetector = (attempt, matches) => {
  if (matches.length === 0) {
    return {
      rule: 'lost_order',
      severity: 'critical',
      message: `${attempt.method} ${attempt.path} never answered and the database holds no order for its idempotency key: sent but never processed`,
      context: { sent: attempt.sent, matched: matches },
    };
  }
  const named = matches
    .map((match) => `${match.id} (${match.status})`)
    .join(', ');
  return {
    rule: 'lost_order',
    severity: 'warning',
    message: matches.every((match) => match.acknowledged)
      ? `${attempt.method} ${attempt.path} never answered but order ${named} was replayed under the same idempotency key: recovered, not lost`
      : `${attempt.method} ${attempt.path} never answered but order ${named} exists: processed but unacknowledged`,
    context: { sent: attempt.sent, matched: matches },
  };
};

// The chaos engine's rules register here; the loop that walks these never changes.
export const DETECTORS: Detector[] = [
  latencyHigh,
  http5xx,
  unexpectedShedding,
  unexpectedStatus,
];

export const RECONCILED_DETECTORS: ReconciledDetector[] = [
  lostOrder,
  duplicateExecution,
];

// What a lost placement can be looked up by: the user, and the key the target stores the
// order under. Every placement the gateway sends carries one.
export type LostPlacement = { userId: number; idempotencyKey: string };

// Only a call that never came back can have been processed unseen. A 4xx or a 5xx is the
// target telling us it did not place the order — reconciling those would report every
// rolled-back placement the API correctly refused as an order lost in transit.
export const lostCandidate = (attempt: Attempt): LostPlacement | undefined => {
  const order =
    attempt.status === 0 &&
    attempt.method === 'POST' &&
    route(attempt.path) === '/orders'
      ? asOrderKey(attempt.sent)
      : undefined;
  return order === undefined || attempt.idempotencyKey === undefined
    ? undefined
    : { userId: order.userId, idempotencyKey: attempt.idempotencyKey };
};

export const reconcilableAt = (attempt: Attempt): number =>
  Date.parse(attempt.at) + LATE_COMMIT_MS;

// Drift is only evidence when both sides were readable and neither moved during the read:
// an order that settles between the two shadow snapshots moves one side and not the other,
// and that is the reader's race, not the target's bug.
// `compared` is how many users the two sides could honestly be held against each other
// for, which is not the same as how many were offered: a check that compared nobody has
// not happened yet, and must not consume the run's next comparison slot.
export const driftFindings = (
  before: ShadowUserSnapshot[],
  after: ShadowUserSnapshot[],
  apiCash: Map<number, string>,
): { compared: number; findings: Finding[] } => {
  const later = new Map(after.map((user) => [user.userId, user]));
  const findings: Finding[] = [];
  let compared = 0;

  for (const user of before) {
    const settled = later.get(user.userId);
    const api = apiCash.get(user.userId);
    if (settled === undefined || api === undefined) {
      continue;
    }
    // A shadow the engine does not trust holds no expectation to compare against: its
    // uncertainty is by design, and alarming on it reports the harness's own blind spot.
    if (
      !user.seeded ||
      user.uncertain ||
      !settled.seeded ||
      settled.uncertain ||
      user.outstanding !== 0 ||
      settled.outstanding !== 0 ||
      user.cash !== settled.cash
    ) {
      continue;
    }

    compared++;
    if (user.cash === api) {
      continue;
    }
    findings.push({
      rule: 'balance_drift',
      severity: 'critical',
      message: `User ${user.userId} cash drifted: the shadow says ${user.cash}, the API says ${api}`,
      context: { userId: user.userId, shadow: user.cash, api },
    });
  }
  return { compared, findings };
};
