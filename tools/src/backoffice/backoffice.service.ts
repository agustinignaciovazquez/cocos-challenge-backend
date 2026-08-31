import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { isChaosEvent } from '../chaos/chaos';
import { GatewayService } from '../gateway/gateway.service';
import {
  SimulationConfig,
  SimulationService,
} from '../simulation/simulation.service';
import {
  ATTEMPTS_CAPACITY,
  Attempt,
  AttemptsStore,
} from '../store/attempts.store';
import { AnomaliesStore } from './anomalies.store';
import { DetectorConfig, MatchedOrder } from './anomaly';
import {
  DETECTORS,
  LostPlacement,
  RECONCILED_DETECTORS,
  driftFindings,
  lostCandidate,
  reconcilableAt,
} from './detectors';
import { Reconciler } from './reconciler';
import { Summary, summarise } from './stats';
import { PatchConfigDto } from './patch-config.dto';

const RECONCILE_EVERY_MS = 10_000;

// The engine records an attempt when its answer lands and annotates it with the rules'
// expectation immediately afterwards. Holding the youngest rows back for a moment means a
// detector never reads a row mid-annotation and calls a decided order an undecided one.
const SETTLE_MS = 250;

const DRIFT_EVERY_ORDERS = 25;

export type BackofficeStats = Summary & {
  config: DetectorConfig;
  anomalies: number;
  reconciler: {
    pending: number;
    lastRunAt: string | null;
    lastError: string | null;
  };
};

const cashOf = (body: unknown): string | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { availableCash } = body as { availableCash?: unknown };
  return typeof availableCash === 'string' ? availableCash : undefined;
};

@Injectable()
export class BackofficeService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BackofficeService.name);
  private config: DetectorConfig = { latencyThresholdMs: 500 };
  private quietSince: number | null = null;
  private loadRunning = false;
  private scanned = 0;
  private simulatedOrders = 0;
  private driftCheckedAt = 0;
  private lastRunAt: string | null = null;
  private lastError: string | null = null;
  private timer?: NodeJS.Timeout;
  private sweeping?: Promise<void>;
  // Attempts whose answer never came, waiting for the target's late-commit window to close
  // before the database is asked whether the order landed anyway.
  private readonly pending = new Map<
    number,
    { attempt: Attempt; lost: LostPlacement }
  >();

  constructor(
    private readonly attempts: AttemptsStore,
    private readonly anomalies: AnomaliesStore,
    private readonly gateway: GatewayService,
    private readonly simulation: SimulationService,
    private readonly reconciler: Reconciler,
  ) {}

  onModuleInit(): void {
    // Always ticking, and every part of the sweep is a no-op with nothing to do — a
    // reconciliation with no candidate due asks the database nothing at all.
    this.timer = setInterval(
      () =>
        void this.sweep().catch((error: unknown) =>
          // Nobody is waiting on the timer's sweep, and an unhandled rejection takes the
          // whole harness down with it.
          this.log.error('The back-office sweep failed', error),
        ),
      RECONCILE_EVERY_MS,
    );
  }

  onModuleDestroy(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  // One sweep at a time: the timer and every polling client share whichever is in flight.
  sweep(): Promise<void> {
    this.sweeping ??= this.run().finally(() => {
      this.sweeping = undefined;
    });
    return this.sweeping;
  }

  async stats(): Promise<BackofficeStats> {
    await this.sweep();
    return {
      ...summarise(this.attempts.recent(ATTEMPTS_CAPACITY), Date.now()),
      config: { ...this.config },
      anomalies: this.anomalies.size(),
      reconciler: {
        pending: this.pending.size,
        lastRunAt: this.lastRunAt,
        lastError: this.lastError,
      },
    };
  }

  async configure(
    patch: PatchConfigDto,
  ): Promise<{ config: DetectorConfig; simulation: SimulationConfig }> {
    // The simulation knobs go first because they are the half that can be refused: an
    // inverted size range is a 400, and a patch that fails must not have moved the
    // threshold on its way out. The threshold itself cannot fail here — the validation
    // pipe has already checked it before the handler ran.
    const simulation = await this.simulation.configure(patch);
    if (patch.latencyThresholdMs !== undefined) {
      this.config = { latencyThresholdMs: patch.latencyThresholdMs };
    }
    return { config: { ...this.config }, simulation };
  }

  // The load engine is the only thing that drives the target hard enough to be shed, and the
  // back-office cannot ask it — the load module is built on this one — so the runner says so
  // on its way in and out.
  setLoadRunning(running: boolean): void {
    this.loadRunning = running;
    this.markQuiet();
  }

  private async run(): Promise<void> {
    this.markQuiet();
    this.scan();
    await this.reconcile();
    await this.checkDrift();
  }

  // When the harness was last seen driving nothing at the target. Taken at the observation
  // rather than at the moment it fell quiet, so a rule reading it can only ever be late to
  // call the target idle — never early, which is the direction that would invent a finding.
  private markQuiet(): void {
    const busy = this.loadRunning || this.simulation.state().config.running;
    this.quietSince = busy ? null : (this.quietSince ?? Date.now());
  }

  private scan(): void {
    const settled = Date.now() - SETTLE_MS;
    const context = { ...this.config, quietSince: this.quietSince };

    for (const attempt of this.attempts.recent(ATTEMPTS_CAPACITY).reverse()) {
      if (attempt.id <= this.scanned) {
        continue;
      }
      if (Date.parse(attempt.at) + attempt.latencyMs > settled) {
        break;
      }
      // A chaos event is the harness's own note in the history rather than a call to the
      // target: no rule speaks about it and no order is owed for it.
      if (isChaosEvent(attempt)) {
        this.scanned = attempt.id;
        continue;
      }
      for (const detect of DETECTORS) {
        const finding = detect(attempt, context);
        if (finding !== undefined) {
          this.anomalies.record({
            ...finding,
            context: { attemptId: attempt.id, ...finding.context },
          });
        }
      }

      if (attempt.expected !== undefined) {
        this.simulatedOrders++;
      }
      const lost = lostCandidate(attempt);
      if (lost !== undefined) {
        this.pending.set(attempt.id, { attempt, lost });
      }
      // Last, so a rule that throws costs the attempt a re-scan rather than its only look.
      this.scanned = attempt.id;
    }
  }

  private async reconcile(): Promise<void> {
    const now = Date.now();
    const due = [...this.pending.values()]
      .filter(({ attempt }) => reconcilableAt(attempt) <= now)
      .sort((a, b) => a.attempt.id - b.attempt.id);
    if (due.length === 0) {
      return;
    }

    const acknowledged = new Set(
      this.attempts
        .recent(ATTEMPTS_CAPACITY)
        .map((attempt) => attempt.orderId)
        .filter((orderId): orderId is number => orderId !== undefined),
    );

    for (const { attempt, lost } of due) {
      let rows;
      try {
        rows = await this.reconciler.matchByKey(
          lost.userId,
          lost.idempotencyKey,
        );
      } catch (error: unknown) {
        // The candidate stays pending: a database that is down says nothing about whether
        // the order landed, and guessing is the one thing this rule must not do.
        this.lastError = error instanceof Error ? error.message : String(error);
        this.log.error('The challenge database could not be read', error);
        return;
      }

      // The key names this attempt's own row, so nothing is claimed away from anyone: the
      // flag says only whether some attempt ever got an answer carrying that order.
      const matches: MatchedOrder[] = rows.map((row) => ({
        ...row,
        acknowledged: acknowledged.has(row.id),
      }));
      this.pending.delete(attempt.id);

      for (const detect of RECONCILED_DETECTORS) {
        const finding = detect(attempt, matches);
        if (finding !== undefined) {
          this.anomalies.record({
            ...finding,
            context: { attemptId: attempt.id, ...finding.context },
          });
        }
      }
    }

    this.lastRunAt = new Date().toISOString();
    this.lastError = null;
  }

  private async checkDrift(): Promise<void> {
    if (this.simulatedOrders - this.driftCheckedAt < DRIFT_EVERY_ORDERS) {
      return;
    }

    const before = this.simulation.state().shadow.users;
    const readable = before.filter(
      (user) => user.seeded && !user.uncertain && user.outstanding === 0,
    );
    if (readable.length === 0) {
      return;
    }

    const readings = await Promise.all(
      readable.map(async (user) => {
        const result = await this.gateway.send(
          'GET',
          `/users/${user.userId}/portfolio`,
        );
        return [
          user.userId,
          result.ok ? cashOf(result.body) : undefined,
        ] as const;
      }),
    );
    const apiCash = new Map<number, string>();
    for (const [userId, cash] of readings) {
      if (cash !== undefined) {
        apiCash.set(userId, cash);
      }
    }

    const after = this.simulation.state().shadow.users;
    const { compared, findings } = driftFindings(before, after, apiCash);
    // A check that could not hold either side against the other has not happened, and
    // must not spend the slot: the next sweep tries again rather than waiting for another
    // twenty-five orders to pass before the harness looks at a balance at all.
    if (compared === 0) {
      return;
    }

    this.driftCheckedAt = this.simulatedOrders;
    for (const finding of findings) {
      this.anomalies.record(finding);
    }
  }
}
