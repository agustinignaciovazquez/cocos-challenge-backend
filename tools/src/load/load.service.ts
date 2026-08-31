import {
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { AnomaliesStore } from '../backoffice/anomalies.store';
import { BackofficeService } from '../backoffice/backoffice.service';
import { LATE_COMMIT_MS } from '../backoffice/detectors';
import { Reconciler } from '../backoffice/reconciler';
import { percentile } from '../backoffice/stats';
import { GatewayService } from '../gateway/gateway.service';
import { HistoryService } from '../history/history.service';
import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { SimulationService } from '../simulation/simulation.service';
import { ATTEMPTS_CAPACITY, AttemptsStore } from '../store/attempts.store';
import { CashReading, PlacedResponse, checkInvariants } from './invariants';
import { Step, planWaves } from './profiles';
import { waitForQuiesce } from './quiesce';
import {
  DEFAULT_PROFILE,
  InvariantResult,
  LoadProfile,
  RunResult,
} from './run';
import { StartLoadDto } from './start-load.dto';

// The gateway gives up on an answer at ten seconds, so everything this run sent has settled
// one way or another within that; the rest of the budget is for whatever else is hammering
// the same users. Past it the run says it could not be stilled rather than hanging.
const QUIESCE_BUDGET_MS = 20_000;
const QUIESCE_POLL_MS = 50;

const RUNS_KEPT = 20;

export type LoadState = {
  running: boolean;
  profile: LoadProfile;
  current: RunResult | null;
  runs: string[];
};

const cashOf = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { availableCash } = body as { availableCash?: unknown };
  return typeof availableCash === 'string' ? availableCash : undefined;
};

// What one run accumulates while it is being fired. Kept apart from the RunResult so the
// result stays the record of the run rather than its scratch space.
type Tally = {
  sent: number;
  // Attempts whose recorder row has not been folded into the summary yet. The ring holds the
  // newest five thousand calls, so a run bigger than that would lose its own early rows if it
  // waited until the end to read them: each wave is folded as soon as it has settled, and one
  // wave cannot outgrow the ring.
  pending: Set<number>;
  latencies: number[];
  placements: PlacedResponse[];
  resting: number[];
  cancelled: number[];
  cancels: { requested: number; cancelled: number; conflicted: number };
};

@Injectable()
export class LoadService {
  private readonly log = new Logger(LoadService.name);
  private profile: LoadProfile = DEFAULT_PROFILE;
  private readonly runs = new Map<string, RunResult>();
  private current: RunResult | null = null;

  constructor(
    private readonly gateway: GatewayService,
    private readonly simulation: SimulationService,
    private readonly reconciler: Reconciler,
    private readonly anomalies: AnomaliesStore,
    private readonly attempts: AttemptsStore,
    private readonly backoffice: BackofficeService,
    private readonly history: HistoryService,
  ) {}

  // One run at a time: two would contend for the same users and neither could then claim
  // which of them a broken invariant belonged to.
  start(overrides: StartLoadDto): RunResult {
    if (this.current !== null) {
      throw new ConflictException(
        `Load run ${this.current.runId} is already ${this.current.phase}`,
      );
    }

    // Named one by one rather than spread: a DTO declares every optional knob as an own
    // property, so spreading one that omitted them overwrites the defaults with undefined.
    this.profile = {
      mode: overrides.mode ?? this.profile.mode,
      concurrency: overrides.concurrency ?? this.profile.concurrency,
      totalOrders: overrides.totalOrders ?? this.profile.totalOrders,
      users: overrides.users ?? this.profile.users,
      sameInstrument: overrides.sameInstrument ?? this.profile.sameInstrument,
      cancelMix: overrides.cancelMix ?? this.profile.cancelMix,
    };

    // The history's id is the run's id: one name for the directory on disk, the record in
    // memory and the runId every invariant anomaly is stamped with.
    const result: RunResult = {
      runId: this.history.open(`load-${this.profile.mode}`, {
        profile: this.profile,
      }),
      profile: this.profile,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      phase: 'placing',
      sent: 0,
      byStatus: {},
      latencyMs: { p50: 0, p95: 0, max: 0, samples: 0 },
      outcomes: {},
      shedding: 0,
      unanswered: 0,
      cancels: { requested: 0, cancelled: 0, conflicted: 0 },
      quiesce: null,
      invariants: [],
      error: null,
    };

    this.current = result;
    this.keep(result);
    // Said out loud because a 503 means something different while this is true: the target
    // shedding load it was asked to shed is not the target refusing traffic it should serve.
    this.backoffice.setLoadRunning(true);
    void this.execute(result)
      .catch((error: unknown) => {
        // Nobody awaits this: the request that started the run has already been answered,
        // and an unhandled rejection would take the harness down with it.
        result.phase = 'failed';
        result.error = error instanceof Error ? error.message : String(error);
        this.log.error(`Load run ${result.runId} failed`, error);
      })
      .finally(() => {
        result.finishedAt = new Date().toISOString();
        this.current = null;
        this.backoffice.setLoadRunning(false);
        this.history.close(result.runId, { ...result });
      });
    return result;
  }

  state(): LoadState {
    return {
      running: this.current !== null,
      profile: this.profile,
      current: this.current,
      runs: [...this.runs.keys()],
    };
  }

  result(runId: string): RunResult {
    const result = this.runs.get(runId);
    if (result === undefined) {
      throw new NotFoundException(`No load run ${runId} is held in memory`);
    }
    return result;
  }

  private keep(result: RunResult): void {
    this.runs.set(result.runId, result);
    for (const runId of [...this.runs.keys()].slice(0, -RUNS_KEPT)) {
      this.runs.delete(runId);
    }
  }

  private async execute(result: RunResult): Promise<void> {
    const users = this.touched(result.profile);
    const tally: Tally = {
      sent: 0,
      pending: new Set(),
      latencies: [],
      placements: [],
      resting: [],
      cancelled: [],
      cancels: result.cancels,
    };

    // The mark is taken before anything is placed, so every row past it belongs to this run
    // and no clock has to be trusted to say so.
    const highWaterMark = await this.reconciler.highWaterMark();
    await this.simulation.prepare(users);

    for (const wave of planWaves(result.profile)) {
      await Promise.allSettled(wave.map((step) => this.fire(step, tally)));
      this.fold(result, tally);
    }

    result.phase = 'quiescing';
    result.quiesce = await waitForQuiesce(
      () => this.simulation.state().shadow.users,
      users,
      QUIESCE_BUDGET_MS,
      QUIESCE_POLL_MS,
    );

    result.phase = 'checking';
    result.invariants = await this.check(result, tally, users, highWaterMark);
    this.report(result);

    // Only now: a shadow re-read while anything was still in flight would be uncertain from
    // birth, and the evolved shadow the check just used would have been thrown away unread.
    await this.simulation.prepare(users);
    result.phase = 'done';
  }

  private touched(profile: LoadProfile): number[] {
    return profile.mode === 'contention'
      ? [profile.users[0]]
      : [...new Set(profile.users)];
  }

  private async fire(step: Step, tally: Tally): Promise<void> {
    if (step.kind === 'cancel') {
      const orderId = tally.resting.shift();
      if (orderId === undefined) {
        return this.place({ kind: 'place', order: step.fallback }, tally);
      }
      return this.cancel(orderId, tally);
    }
    return this.place(step, tally);
  }

  private async place(
    step: Extract<Step, { kind: 'place' }>,
    tally: Tally,
  ): Promise<void> {
    const placement = await this.simulation.place(step.order);
    this.issued(tally, placement.attemptId);
    if (placement.placed === undefined) {
      return;
    }

    const { id, status, size, price } = placement.placed;
    tally.placements.push({ orderId: id, status, size, price });
    // Only a LIMIT order rests, and a resting order is the only thing a cancel can take.
    if (status === 'NEW') {
      tally.resting.push(id);
    }
  }

  // No reserve and no settle: a resting order holds nothing in the shadow and a cancelled one
  // moves nothing, so there is no bookkeeping for this call to take part in — only the
  // recorder's row, which every request the harness makes gets.
  private async cancel(orderId: number, tally: Tally): Promise<void> {
    const result = await this.gateway.send(
      'PATCH',
      `/orders/${orderId}/cancel`,
    );
    this.issued(tally, result.attemptId);
    tally.cancels.requested++;

    if (result.ok) {
      tally.cancels.cancelled++;
      tally.cancelled.push(orderId);
    } else if (result.status === 409) {
      tally.cancels.conflicted++;
    }
  }

  private issued(tally: Tally, attemptId: number): void {
    tally.sent++;
    tally.pending.add(attemptId);
  }

  // Folds the wave that has just settled out of the recorder and into the run's totals. The
  // recorder is the one place a status or a latency is measured, and reading it a wave at a
  // time is what keeps a long run from being summarised out of a ring that has already moved
  // past its own beginning.
  private fold(result: RunResult, tally: Tally): void {
    for (const attempt of this.attempts.recent(ATTEMPTS_CAPACITY)) {
      if (!tally.pending.delete(attempt.id)) {
        continue;
      }
      const status = String(attempt.status);
      result.byStatus[status] = (result.byStatus[status] ?? 0) + 1;
      // A call that never answered contributes a give-up time, not a latency.
      if (attempt.status !== 0) {
        tally.latencies.push(attempt.latencyMs);
      }
      if (attempt.actual !== undefined) {
        result.outcomes[attempt.actual] =
          (result.outcomes[attempt.actual] ?? 0) + 1;
      }
    }

    result.sent = tally.sent;
    result.shedding = result.byStatus['503'] ?? 0;
    result.unanswered = result.byStatus['0'] ?? 0;
    result.latencyMs = {
      p50: percentile(tally.latencies, 0.5),
      p95: percentile(tally.latencies, 0.95),
      max: percentile(tally.latencies, 1),
      samples: tally.latencies.length,
    };
  }

  private async check(
    result: RunResult,
    tally: Tally,
    users: number[],
    highWaterMark: number,
  ): Promise<InvariantResult[]> {
    const before = this.simulation.state().shadow.users;
    const first = await this.readCash(users);

    const rows = await this.reconciler.ledger(users);
    // The balance is read again on the far side of the ledger read. The two are separate
    // round trips, so an order settling between them moves the fold and not the balance, and
    // a quiesce that timed out guarantees there are still orders able to do it. A balance
    // that did not stand still is not evidence either way.
    const second = await this.readCash(users);
    const apiCash = this.stillCash(users, first, second);
    // Read after the rows, so an order that has just committed has had its answer recorded by
    // the time the row it wrote is being asked about. The run's own answers are added from
    // its tally rather than looked up: a run longer than the recorder's ring has already
    // pushed its earliest calls out of it, and those rows would otherwise read as orders
    // nobody ever answered for.
    const acknowledged = new Set([
      ...this.attempts
        .recent(ATTEMPTS_CAPACITY)
        .map((attempt) => attempt.orderId)
        .filter((orderId): orderId is number => orderId !== undefined),
      ...tally.placements.map(({ orderId }) => orderId),
    ]);
    const after = this.simulation.state().shadow.users;

    return checkInvariants({
      rows,
      highWaterMark,
      apiCash,
      shadowCash: this.comparable(before, after, users),
      placements: tally.placements,
      acknowledged,
      unanswered: this.unansweredIn(result, tally),
      cancelled: tally.cancelled,
    });
  }

  // How many placements could have committed a row in the run window without anything being
  // able to name it. Counted off the recorder rather than off this run's tally, because the
  // rows it is set against belong to every client of these users: a simulation order that
  // timed out mid-run writes a row the load engine never sent and never saw.
  //
  // The window opens before the run does, by the target's own late-commit ceiling, since a
  // call already in flight when the run started can still land a row past the mark.
  private unansweredIn(result: RunResult, tally: Tally): number {
    const from = Date.parse(result.startedAt) - LATE_COMMIT_MS;
    const lost = this.attempts
      .recent(ATTEMPTS_CAPACITY)
      .filter(
        (attempt) =>
          attempt.status === 0 &&
          attempt.method === 'POST' &&
          attempt.path.split('?')[0] === '/orders' &&
          Date.parse(attempt.at) >= from,
      ).length;

    // An attempt the ring dropped is unaccounted for in both directions at once: had it been
    // answered its order id would already be in the tally, and had it not, its row is one
    // nothing can name. One already folded is dropped from the ring just the same, so the
    // run's own count — taken as each wave settled, and eviction-proof for that reason —
    // stands beside the ring's, and one still pending beside both. Counting a loss twice
    // only widens the allowance, which is the sole direction worth erring in here.
    return lost + result.unanswered + tally.pending.size;
  }

  private async readCash(users: number[]): Promise<Map<number, string>> {
    const cash = new Map<number, string>();
    for (const userId of users) {
      const read = await this.gateway.send('GET', `/users/${userId}/portfolio`);
      const balance = read.ok ? cashOf(read.body) : undefined;
      if (balance !== undefined) {
        cash.set(userId, balance);
      }
    }
    return cash;
  }

  // Only a balance that answered the same figure on both sides of the ledger read is evidence
  // about it. One that moved was racing traffic this run does not own; one that never came is
  // a target that was not answering. Neither is conservation being broken.
  private stillCash(
    users: number[],
    first: Map<number, string>,
    second: Map<number, string>,
  ): Map<number, CashReading> {
    const readings = new Map<number, CashReading>();
    for (const userId of users) {
      const before = first.get(userId);
      const after = second.get(userId);

      if (before === undefined || after === undefined) {
        readings.set(userId, {
          unavailable: 'the API balance could not be read',
        });
      } else if (before !== after) {
        readings.set(userId, {
          unavailable: `it read ${before} before the rows and ${after} after them`,
        });
      } else {
        readings.set(userId, { cash: before });
      }
    }
    return readings;
  }

  // The shadow the run evolved is only evidence if it stood still across the readings and
  // the engine never stopped trusting it. This is the same honesty the drift rule applies
  // in flight, and it is why the re-seed happens after the check rather than before: a
  // freshly seeded shadow would agree with the API by construction and prove nothing.
  private comparable(
    before: ShadowUserSnapshot[],
    after: ShadowUserSnapshot[],
    users: number[],
  ): Map<number, string> {
    const later = new Map(after.map((user) => [user.userId, user]));
    const cash = new Map<number, string>();

    for (const user of before) {
      const settled = later.get(user.userId);
      if (
        !users.includes(user.userId) ||
        settled === undefined ||
        !user.seeded ||
        user.uncertain ||
        settled.uncertain ||
        user.outstanding !== 0 ||
        settled.outstanding !== 0 ||
        user.cash !== settled.cash
      ) {
        continue;
      }
      cash.set(user.userId, user.cash);
    }
    return cash;
  }

  private report(result: RunResult): void {
    for (const invariant of result.invariants.filter(({ pass }) => !pass)) {
      this.anomalies.record({
        rule: 'invariant_violation',
        severity: 'critical',
        message: `${invariant.name} does not hold after ${result.runId}: ${invariant.detail}`,
        context: {
          runId: result.runId,
          invariant: invariant.name,
          profile: result.profile,
        },
      });
    }
  }
}
