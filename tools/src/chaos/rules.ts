import { MatchedOrder, ReconciledDetector } from '../backoffice/anomaly';
import { logicalKey } from '../order';

const executed = (matches: MatchedOrder[]): MatchedOrder[] =>
  matches.filter((match) => match.status === 'FILLED');

// The probe's whole point: one logical order sent twice under one key, once for real and once
// as the retry of a response nobody saw. The API promises one order per (user, key), so a
// second row is that promise broken — the retry executed again.
export const duplicateExecution: ReconciledDetector = (attempt, matches) => {
  if (
    attempt.idempotencyKey === undefined ||
    attempt.chaos?.retriedBy === undefined ||
    matches.length < 2
  ) {
    return undefined;
  }
  const fills = executed(matches);
  const order = logicalKey(attempt.sent);
  return {
    rule: 'duplicate_execution',
    severity: 'critical',
    message: `One logical order (${order ?? 'unrecognised'}) was sent twice under idempotency key ${attempt.idempotencyKey} after its response was dropped, and the database holds ${matches.length} rows for it, ${fills.length} of them FILLED: the API did not recognise its own key`,
    context: {
      order,
      idempotencyKey: attempt.idempotencyKey,
      rows: matches,
      retriedBy: attempt.chaos.retriedBy,
      droppedStatus: attempt.chaos.droppedStatus,
    },
  };
};
