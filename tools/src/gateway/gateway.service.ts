import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { isOrderPlacement, placedOrderId } from '../chaos/chaos';
import { ChaosService } from '../chaos/chaos.service';
import { Attempt, AttemptsStore, ChaosMark } from '../store/attempts.store';

const TARGET = process.env.TARGET_API_URL ?? 'http://localhost:3000';

// A harness that hangs on one request stops measuring, so an answer that never comes is
// turned into a recorded failure instead of an open socket.
const TIMEOUT_MS = 10_000;

const DROPPED = 'chaos: the response was dropped before the client saw it';

export type GatewayResult = {
  attemptId: number;
  status: number;
  ok: boolean;
  body: unknown;
};

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
};

const marked = (
  attempt: Omit<Attempt, 'id'>,
  chaos: ChaosMark,
): Omit<Attempt, 'id'> =>
  Object.keys(chaos).length === 0 ? attempt : { ...attempt, chaos };

@Injectable()
export class GatewayService {
  constructor(
    private readonly attempts: AttemptsStore,
    private readonly chaos: ChaosService,
  ) {}

  async send(
    method: string,
    path: string,
    sent?: unknown,
  ): Promise<GatewayResult> {
    // The target refuses a placement without one, and takes one order per (user, key): the
    // key names the logical order, so it is minted here and not per attempt.
    const key = isOrderPlacement(method, path) ? randomUUID() : undefined;
    const chaos: ChaosMark = {};
    const delayedMs = await this.chaos.delay();
    if (delayedMs > 0) {
      chaos.delayedMs = delayedMs;
    }

    const attempt = await this.call(method, path, sent, key);
    // What the caller waited is the round trip plus whatever it was held back by: a delay
    // outside the measured window is a delay the latency rule can never see, and proving the
    // monitor catches a slow answer is the whole point of injecting one. The send stamp is
    // left where it is, so the reconciler still opens its window on the real request.
    attempt.latencyMs += delayedMs;

    // The answer is read and then hidden rather than aborted mid-flight, because a drop that
    // races the target's commit proves nothing: the probe needs an order that certainly
    // landed. What the caller was not told is kept on the row so history stays honest.
    if (attempt.status !== 0 && this.chaos.dropsResponse(method, path)) {
      chaos.droppedStatus = attempt.status;
      attempt.status = 0;
      attempt.ok = false;
      attempt.body = { message: DROPPED };
    }

    const lost = this.record(marked(attempt, chaos));
    if (chaos.droppedStatus !== undefined) {
      this.chaos.droppedResponse(lost.attemptId, chaos.droppedStatus);
    }
    return lost.status === 0
      ? this.probe(method, path, sent, key, lost, chaos)
      : lost;
  }

  // The idempotency probe: a client that never learned the answer re-sends the order under
  // the original's key, once, which is what the API asks a retry to do — a second execution
  // now would be the target failing to recognise its own key. The caller still gets the loss
  // it was handed, because that is what it really suffered.
  private async probe(
    method: string,
    path: string,
    sent: unknown,
    key: string | undefined,
    lost: GatewayResult,
    chaos: ChaosMark,
  ): Promise<GatewayResult> {
    if (!this.chaos.retriesOrder(method, path)) {
      return lost;
    }

    const attempt = await this.call(method, path, sent, key);
    const orderId = placedOrderId(attempt.body);
    const retry = this.record({
      ...attempt,
      orderId,
      chaos: { retryOf: lost.attemptId },
    });
    this.attempts.annotate(lost.attemptId, {
      chaos: { ...chaos, retriedBy: retry.attemptId },
    });
    this.chaos.retriedOrder(lost.attemptId, sent, {
      attemptId: retry.attemptId,
      status: retry.status,
      orderId,
    });
    return lost;
  }

  private async call(
    method: string,
    path: string,
    sent?: unknown,
    key?: string,
  ): Promise<Omit<Attempt, 'id'>> {
    const startedAt = Date.now();
    const at = new Date(startedAt).toISOString();
    const headers: Record<string, string> = {};
    if (sent !== undefined) {
      headers['content-type'] = 'application/json';
    }
    if (key !== undefined) {
      headers['Idempotency-Key'] = key;
    }

    try {
      const response = await fetch(`${TARGET}${path}`, {
        method,
        headers,
        body: sent === undefined ? undefined : JSON.stringify(sent),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const text = await response.text();

      return {
        at,
        method,
        path,
        latencyMs: Date.now() - startedAt,
        status: response.status,
        ok: response.ok,
        sent,
        idempotencyKey: key,
        body: text === '' ? undefined : parse(text),
      };
    } catch (error) {
      return {
        at,
        method,
        path,
        latencyMs: Date.now() - startedAt,
        status: 0,
        ok: false,
        sent,
        idempotencyKey: key,
        body: {
          message: error instanceof Error ? error.message : String(error),
        },
      };
    }
  }

  private record(attempt: Omit<Attempt, 'id'>): GatewayResult {
    return {
      attemptId: this.attempts.record(attempt),
      status: attempt.status,
      ok: attempt.ok,
      body: attempt.body,
    };
  }
}
