import { LedgerRow } from '../backoffice/anomaly';
import { InvariantResult } from './run';

// Every money value in play is a two-decimal string — the column's own text and the API's
// own serialisation — so centavos are read off it rather than through a float.
export const centavosOf = (decimal: string): bigint => {
  const negative = decimal.trimStart().startsWith('-');
  const [whole, fraction = ''] = decimal.replace('-', '').trim().split('.');
  const value = BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
  return negative ? -value : value;
};

export const moneyOf = (centavos: bigint): string => {
  const magnitude = centavos < 0n ? -centavos : centavos;
  const hundredths = (magnitude % 100n).toString().padStart(2, '0');
  return `${centavos < 0n ? '-' : ''}${magnitude / 100n}.${hundredths}`;
};

// The two folds the challenge computes in SQL, restated here over the rows themselves. A
// side the API does not recognise contributes nothing, exactly as its CASE without an ELSE
// contributes NULL to a SUM.
export const cashDelta = (row: LedgerRow): bigint => {
  if (row.status !== 'FILLED') {
    return 0n;
  }
  const amount = centavosOf(row.price) * BigInt(row.size);
  switch (row.side) {
    case 'CASH_IN':
    case 'SELL':
      return amount;
    case 'CASH_OUT':
    case 'BUY':
      return -amount;
    default:
      return 0n;
  }
};

export const shareDelta = (row: LedgerRow): number => {
  if (row.status !== 'FILLED') {
    return 0;
  }
  if (row.side === 'BUY') {
    return row.size;
  }
  return row.side === 'SELL' ? -row.size : 0;
};

const byUser = (rows: LedgerRow[]): Map<number, LedgerRow[]> => {
  const grouped = new Map<number, LedgerRow[]>();
  for (const row of rows) {
    const held = grouped.get(row.userId) ?? [];
    held.push(row);
    grouped.set(row.userId, held);
  }
  return grouped;
};

// A failure is recorded as an anomaly, and a ring of five hundred of those must not be able
// to hold one run's every breach: enough of them to see the shape, and a count for the rest.
const REPORTED_BREACHES = 5;

const verdict = (
  name: string,
  notes: string[],
  breaches: string[],
): InvariantResult => {
  if (breaches.length === 0) {
    return { name, pass: true, detail: notes.join('; ') || 'nothing to check' };
  }
  const shown = breaches.slice(0, REPORTED_BREACHES).join('; ');
  const rest = breaches.length - REPORTED_BREACHES;
  return {
    name,
    pass: false,
    detail: rest > 0 ? `${shown} (and ${rest} more)` : shown,
  };
};

// A balance the API reported and a fold of the rows behind it are read one after the other,
// never at the same instant. A fill landing in between moves one and not the other, and that
// is the reader's race rather than the target's bug.
//
// A balance that could not be read at all is no better as evidence. Conservation is a claim
// about what the ledger says, and a target that did not answer has not broken it — it has
// left it unchecked, which the run says out loud rather than calling a violation. The outage
// itself is not thereby hidden: every unanswered call is already an http_5xx critical and is
// counted in the run's own summary.
export type CashReading = { cash: string } | { unavailable: string };

export const conservation = (
  rows: LedgerRow[],
  apiCash: Map<number, CashReading>,
  shadowCash: Map<number, string>,
): InvariantResult => {
  const notes: string[] = [];
  const breaches: string[] = [];

  for (const [userId, owned] of byUser(rows)) {
    const db = moneyOf(
      owned.reduce((total, row) => total + cashDelta(row), 0n),
    );
    const reading = apiCash.get(userId) ?? {
      unavailable: 'no API balance was read for this user',
    };
    if ('unavailable' in reading) {
      notes.push(
        `user ${userId}: the FILLED fold says ${db}, API leg not comparable — ${reading.unavailable}`,
      );
      continue;
    }

    const api = reading.cash;
    if (api !== db) {
      breaches.push(
        `user ${userId}: API says ${api}, the FILLED fold says ${db}`,
      );
      continue;
    }

    const shadow = shadowCash.get(userId);
    if (shadow === undefined) {
      notes.push(
        `user ${userId}: API ${api} == fold ${db}, shadow leg not comparable`,
      );
    } else if (shadow !== db) {
      breaches.push(
        `user ${userId}: API and fold agree at ${db}, the shadow says ${shadow}`,
      );
    } else {
      notes.push(
        `user ${userId}: API ${api} == fold ${db} == shadow ${shadow}`,
      );
    }
  }
  return verdict('conservation', notes, breaches);
};

// The advisory lock is what makes this true: two placements that both read the same balance
// would each be covered on their own and overdraw together, and the running fold is where
// that shows. Nothing is subtracted before the CASH_IN, so the fold starts at zero and the
// first row can only be a credit.
export const noOverdraft = (rows: LedgerRow[]): InvariantResult => {
  const notes: string[] = [];
  const breaches: string[] = [];

  for (const [userId, owned] of byUser(rows)) {
    let fold = 0n;
    let low = 0n;
    let lowAt = 0;
    for (const row of owned) {
      fold += cashDelta(row);
      if (fold < low) {
        low = fold;
        lowAt = row.id;
      }
    }
    if (low < 0n) {
      breaches.push(
        `user ${userId}: the cash fold reached ${moneyOf(low)} at order ${lowAt}`,
      );
    } else {
      notes.push(
        `user ${userId}: ${owned.length} rows, the cash fold never dipped below 0.00`,
      );
    }
  }
  return verdict('no_overdraft', notes, breaches);
};

// A position can only be sold down to zero, so after any row the target accepted the fold is
// at least zero — and the run therefore cannot push it below wherever the seed had already
// left it. That prefix minimum is the floor, and it is already at most zero because the fold
// starts there: for user 1 in BMA the seed leaves it at −10.
export const noOversell = (
  rows: LedgerRow[],
  highWaterMark: number,
): InvariantResult => {
  const folds = new Map<string, { fold: number; floor: number }>();
  const breaches: string[] = [];
  let counted = 0;

  for (const row of rows) {
    const delta = shareDelta(row);
    const key = `${row.userId}/${row.instrumentId}`;
    const position = folds.get(key) ?? { fold: 0, floor: 0 };
    position.fold += delta;

    if (row.id <= highWaterMark) {
      position.floor = Math.min(position.floor, position.fold);
    } else if (position.fold < position.floor) {
      breaches.push(
        `user ${row.userId} instrument ${row.instrumentId}: order ${row.id} took the position to ${position.fold}, under its floor of ${position.floor}`,
      );
    }
    folds.set(key, position);
    counted++;
  }

  const floors = [...folds]
    .filter(([, { floor }]) => floor < 0)
    .map(([key, { floor }]) => `${key} floor ${floor}`);
  return verdict(
    'no_oversell',
    [
      `${folds.size} positions over ${counted} rows never went under their pre-run floor`,
      ...floors,
    ],
    breaches,
  );
};

export type PlacedResponse = {
  orderId: number;
  status: string;
  size: number;
  price: string;
};

// Both directions, because they fail differently: a response naming an order the database
// does not hold is the target answering for work it did not do, and a row nothing answered
// for is work it did without telling anyone.
export const responseDbAgreement = (
  placements: PlacedResponse[],
  rows: LedgerRow[],
  highWaterMark: number,
  acknowledged: Set<number>,
  unanswered: number,
  cancelled: number[] = [],
): InvariantResult => {
  const held = new Map(rows.map((row) => [row.id, row]));
  const cancelledByRun = new Set(cancelled);
  const breaches: string[] = [];

  // A row is read after the run finished, and the run may have cancelled it in the meantime.
  // NEW to CANCELLED is the API's only transition and this run knows which orders it asked
  // for, so that one move is excused and every other difference is not: a row that reads
  // CANCELLED without having been asked for, or a FILLED order that ended up cancelled, is
  // exactly the cancel-against-fill race this is here to catch.
  const agrees = (row: LedgerRow, placement: PlacedResponse): boolean =>
    row.status === placement.status ||
    (placement.status === 'NEW' &&
      row.status === 'CANCELLED' &&
      cancelledByRun.has(row.id));

  for (const placement of placements) {
    const row = held.get(placement.orderId);
    if (row === undefined) {
      breaches.push(
        `order ${placement.orderId} was answered for but the database holds no such row`,
      );
      continue;
    }
    if (
      !agrees(row, placement) ||
      row.size !== placement.size ||
      row.price !== placement.price
    ) {
      breaches.push(
        `order ${placement.orderId}: the response said ${placement.status}/${placement.size}/${placement.price}, the row says ${row.status}/${row.size}/${row.price}`,
      );
    }
  }

  const created = rows.filter((row) => row.id > highWaterMark);
  const unmatched = created.filter((row) => !acknowledged.has(row.id));
  // A call that never answered can still have committed its row, and that row is nobody's
  // bug — it is the lost-order case the back-office already reconciles. Only rows past what
  // the losses can account for are orders the target created out of nothing. The rows span
  // every client of these users, so the allowance has to as well: counting only the run's own
  // losses would report a simulation order that timed out mid-run as a phantom.
  if (unmatched.length > unanswered) {
    breaches.push(
      `${unmatched.length} rows in the run window were never answered for but only ${unanswered} calls went unanswered: ${unmatched
        .slice(0, 10)
        .map((row) => row.id)
        .join(', ')}`,
    );
  }

  return verdict(
    'response_db_agreement',
    [
      `${placements.length} answered orders match their rows`,
      `${created.length} rows created in the run, ${created.length - unmatched.length} acknowledged, ${unmatched.length} unmatched against ${unanswered} unanswered calls`,
    ],
    breaches,
  );
};

// Cancelling must not move money. In this target it structurally cannot — a balance is the
// fold of FILLED rows rather than a stored number — so the check that carries the weight is
// the other half: an order the API said it cancelled has to read CANCELLED, which is what
// fails if a cancel ever won a race against a fill.
export const cancelSafety = (
  rows: LedgerRow[],
  cancelled: number[],
): InvariantResult => {
  const held = new Map(rows.map((row) => [row.id, row]));
  const breaches: string[] = [];

  for (const id of cancelled) {
    const row = held.get(id);
    if (row === undefined) {
      breaches.push(
        `order ${id} was cancelled but the database holds no such row`,
      );
    } else if (row.status !== 'CANCELLED') {
      breaches.push(`order ${id} was cancelled but reads ${row.status}`);
    }
  }

  const withoutCancelled = rows.filter((row) => row.status !== 'CANCELLED');
  const cash = moneyOf(rows.reduce((total, row) => total + cashDelta(row), 0n));
  const cashWithout = moneyOf(
    withoutCancelled.reduce((total, row) => total + cashDelta(row), 0n),
  );
  if (cash !== cashWithout) {
    breaches.push(
      `dropping the CANCELLED rows moved the cash fold from ${cash} to ${cashWithout}`,
    );
  }

  const shares = rows.reduce((total, row) => total + shareDelta(row), 0);
  const sharesWithout = withoutCancelled.reduce(
    (total, row) => total + shareDelta(row),
    0,
  );
  if (shares !== sharesWithout) {
    breaches.push(
      `dropping the CANCELLED rows moved the holdings fold from ${shares} to ${sharesWithout}`,
    );
  }

  const dropped = rows.length - withoutCancelled.length;
  return verdict(
    'cancel_safety',
    [
      `${cancelled.length} orders cancelled in the run all read CANCELLED`,
      `${dropped} CANCELLED rows contribute nothing to either fold`,
    ],
    breaches,
  );
};

export type RunEvidence = {
  rows: LedgerRow[];
  highWaterMark: number;
  apiCash: Map<number, CashReading>;
  shadowCash: Map<number, string>;
  placements: PlacedResponse[];
  acknowledged: Set<number>;
  unanswered: number;
  cancelled: number[];
};

export const checkInvariants = (evidence: RunEvidence): InvariantResult[] => [
  conservation(evidence.rows, evidence.apiCash, evidence.shadowCash),
  noOverdraft(evidence.rows),
  noOversell(evidence.rows, evidence.highWaterMark),
  responseDbAgreement(
    evidence.placements,
    evidence.rows,
    evidence.highWaterMark,
    evidence.acknowledged,
    evidence.unanswered,
    evidence.cancelled,
  ),
  cancelSafety(evidence.rows, evidence.cancelled),
];
