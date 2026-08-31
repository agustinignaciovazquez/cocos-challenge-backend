import { Injectable } from '@nestjs/common';
import { Expectation, OrderStatus } from '../order';

export const ATTEMPTS_CAPACITY = 5000;

// What the chaos engine did to this call: how long it was held back, the answer that was
// hidden from the caller, and the two ends of a retry probe. Absent on a call chaos never
// touched, so history can always tell an injected failure from one the target produced.
export type ChaosMark = {
  delayedMs?: number;
  droppedStatus?: number;
  retryOf?: number;
  retriedBy?: number;
};

export type Attempt = {
  id: number;
  at: string;
  method: string;
  path: string;
  latencyMs: number;
  // 0 when the request never got an answer at all — a transport failure or a timeout.
  status: number;
  ok: boolean;
  sent?: unknown;
  body?: unknown;
  expected?: Expectation;
  actual?: OrderStatus;
  orderId?: number;
  // The key this placement was sent under, so the row can be tied to the order the target
  // stored for it. Absent on everything that is not a placement.
  idempotencyKey?: string;
  chaos?: ChaosMark;
};

@Injectable()
export class AttemptsStore {
  private readonly buffer: Attempt[] = [];
  private cursor = 0;
  private nextId = 1;
  private sink?: (attempt: Attempt) => void;

  // Where every row is copied for the run history. The ring stays the live answer; this is
  // the copy that outlives it, and nothing on the recording path waits for it.
  tap(sink: (attempt: Attempt) => void): void {
    this.sink = sink;
  }

  record(attempt: Omit<Attempt, 'id'>): number {
    const row: Attempt = { id: this.nextId++, ...attempt };
    if (this.buffer.length < ATTEMPTS_CAPACITY) {
      this.buffer.push(row);
    } else {
      this.buffer[this.cursor] = row;
    }
    this.cursor = (this.cursor + 1) % ATTEMPTS_CAPACITY;
    // Handed over one turn later, so the expectation and the outcome the caller writes onto
    // the row as soon as its answer settles are already on it: a row on disk without them is
    // half the evidence. An annotation made after a further round trip — the retry probe's
    // back-link — is a live-buffer nicety the file does not promise.
    if (this.sink !== undefined) {
      setImmediate(() => this.sink?.(row));
    }
    return row.id;
  }

  // Ids and slots advance together, so attempt N always sits at (N - 1) % capacity until
  // the ring overwrites it — the id check is what tells those two cases apart.
  annotate(id: number, details: Partial<Attempt>): void {
    const row = this.buffer.at((id - 1) % ATTEMPTS_CAPACITY);
    if (row?.id === id) {
      Object.assign(row, details);
    }
  }

  recent(limit: number): Attempt[] {
    const size = this.buffer.length;
    const wanted = Math.min(limit, size);
    const newest: Attempt[] = [];
    for (let back = 1; back <= wanted; back++) {
      newest.push(this.buffer[(this.cursor - back + size) % size]);
    }
    return newest;
  }

  size(): number {
    return this.buffer.length;
  }
}
