// The vocabulary of one run's trace on disk. A run is a window the harness was working in —
// a simulation start→stop, or one load run — and everything the recorder saw while it was
// open is in its files, whoever sent it. Which calls the run itself placed is what the
// summary answers; the trace answers what was happening around them.

import { ChaosConfig } from '../chaos/chaos';

// Written when the run opens, so a run that is killed still names itself, and rewritten when
// it closes with the end stamp and whatever the run has to say about itself.
export type RunManifest = {
  runId: string;
  mode: string;
  startedAt: string;
  finishedAt: string | null;
  config: Record<string, unknown>;
  // Both ends of the window: a mode switched on mid-run shows up as a `chaos:` row in the
  // attempts file, and these two say what was already running before that and what outlived it.
  chaos: { atStart: ChaosConfig; atEnd: ChaosConfig | null };
  summary: Record<string, unknown> | null;
};

export type RunCounts = { attempts: number; anomalies: number };

export type Page = {
  runId: string;
  offset: number;
  limit: number;
  total: number;
  rows: unknown[];
};

// Directory names sort the runs the way they happened; the mode says what to expect inside.
// Colons and dots are not directory-safe everywhere, and the id is the directory.
export const runIdFor = (mode: string, at: Date): string =>
  `${at.toISOString().replace(/[:.]/g, '-')}-${mode}`;

export const RUN_ID = /^[0-9A-Za-z-]+$/;

const parsed = (line: string): unknown => {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
};

// A run killed mid-write can leave its last line torn. It still counts in `total` — that is
// the tell that the file was cut short — but it is dropped from the page rather than taking
// the whole read down with it, since a partial trace is the evidence a crash was meant to leave.
export const pageOf = (
  text: string,
  offset: number,
  limit: number,
): Pick<Page, 'total' | 'rows'> => {
  const lines = text.split('\n').filter((line) => line !== '');
  return {
    total: lines.length,
    rows: lines
      .slice(offset, offset + limit)
      .map(parsed)
      .filter((row) => row !== undefined),
  };
};
