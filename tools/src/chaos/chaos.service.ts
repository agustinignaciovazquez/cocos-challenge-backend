import {
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { logicalKey } from '../order';
import { AttemptsStore } from '../store/attempts.store';
import {
  CHAOS_MODES,
  ChaosConfig,
  ChaosMode,
  ChaosState,
  ChaosToggle,
  RetryOutcome,
  chaosEvent,
  isOrderPlacement,
} from './chaos';
import { ChaosConfigDto } from './chaos-config.dto';

const run = promisify(execFile);

// The challenge repo's own compose file: the harness pauses that database and nothing else.
// The harness lives in `tools/` inside that repo, so the default is one directory up.
const COMPOSE_DIR =
  process.env.CHALLENGE_REPO_DIR ?? resolve(process.cwd(), '..');

const MAX_DELAY_MS = 5_000;
const MAX_PAUSE_SECONDS = 30;

// How long after a mode stops it can still be named as the cause of a finding: the sweep
// interval plus the reconciler's late-commit window, with room to spare.
export const CHAOS_WINDOW_MS = 30_000;

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

const off = (intensity: number): { enabled: boolean; intensity: number } => ({
  enabled: false,
  intensity,
});

@Injectable()
export class ChaosService implements OnModuleDestroy {
  private readonly log = new Logger(ChaosService.name);
  // Everything off, always: a harness that starts breaking things on boot cannot be trusted
  // to say what the target does on its own. The intensities are what each mode takes when it
  // is switched on without one.
  private modes: ChaosConfig = {
    latency_injection: off(250),
    response_drop: off(0.2),
    client_retry: off(1),
    db_pause: off(5),
  };
  private readonly counters = { delays: 0, drops: 0, retries: 0, pauses: 0 };
  private readonly stoppedAt = new Map<ChaosMode, number>();
  private pausedUntil: number | null = null;
  private lastError: string | null = null;

  constructor(private readonly attempts: AttemptsStore) {}

  state(): ChaosState {
    return {
      modes: { ...this.modes },
      active: this.active(),
      dbPausedUntil:
        this.pausedUntil === null
          ? null
          : new Date(this.pausedUntil).toISOString(),
      counters: { ...this.counters },
      lastError: this.lastError,
    };
  }

  // What was being done to the target around the time a finding was made. Every anomaly
  // carries this, so a real bug found during an experiment is not lost among the ones the
  // harness caused.
  //
  // A window rather than an instant: the back-office sweeps every ten seconds and reconciles
  // a lost order sixteen seconds after it was sent, so a mode is nearly always off again by
  // the time the finding it caused is made — a five-second database pause would otherwise
  // never be blamed for anything. Over-naming a mode for half a minute after it stopped is
  // the safe direction to err in; the anomaly's own timestamp is there to check it against.
  active(): ChaosMode[] {
    const since = Date.now() - CHAOS_WINDOW_MS;
    return CHAOS_MODES.filter(
      (mode) =>
        this.modes[mode].enabled || (this.stoppedAt.get(mode) ?? 0) >= since,
    );
  }

  configure(patch: ChaosConfigDto): ChaosState {
    const current = this.modes[patch.mode];
    const intensity = patch.intensity ?? current.intensity;
    const enabled = patch.enabled ?? current.enabled;
    this.check(patch.mode, intensity);

    this.switch(patch.mode, { enabled, intensity });
    this.event(patch.mode, true, { enabled, intensity });
    // A pause is an act rather than a state: switching it on runs one and switches itself off
    // afterwards, so the toggle always reads what the database is actually doing.
    if (patch.mode === 'db_pause' && enabled) {
      void this.pauseDb(intensity);
    }
    return this.state();
  }

  // Client-side latency, applied before the request leaves; the gateway adds it back onto
  // what it measured, so the recorder reports what the caller actually waited.
  async delay(): Promise<number> {
    const { enabled, intensity } = this.modes.latency_injection;
    const ms = enabled ? Math.floor(Math.random() * (intensity + 1)) : 0;
    if (ms > 0) {
      this.counters.delays++;
      await sleep(ms);
    }
    return ms;
  }

  // The dice are rolled only for the calls a mode applies to, so an intensity means what it
  // says: one placement in five, not one call in five of which few are placements.
  dropsResponse(method: string, path: string): boolean {
    return isOrderPlacement(method, path) && this.rolls('response_drop');
  }

  retriesOrder(method: string, path: string): boolean {
    return isOrderPlacement(method, path) && this.rolls('client_retry');
  }

  droppedResponse(attemptId: number, hiddenStatus: number): void {
    this.counters.drops++;
    this.event('response_drop', true, { attemptId, hiddenStatus });
  }

  // The retry's own answer is written down beside it: under a working key a replay is a 200
  // naming the original's order, and that shape is what the probe now exists to check.
  retriedOrder(of: number, sent: unknown, retry: RetryOutcome): void {
    this.counters.retries++;
    this.event('client_retry', true, {
      of,
      retry: retry.attemptId,
      order: logicalKey(sent) ?? null,
      status: retry.status,
      orderId: retry.orderId ?? null,
    });
  }

  // A pause that outlives the harness is the one chaos side effect that hurts the operator
  // rather than the experiment, so the last thing this service does is undo it.
  async onModuleDestroy(): Promise<void> {
    if (this.pausedUntil !== null) {
      await this.compose('unpause').catch((error: unknown) =>
        this.log.error('The challenge database is still paused', error),
      );
    }
  }

  private switch(mode: ChaosMode, toggle: ChaosToggle): void {
    if (this.modes[mode].enabled && !toggle.enabled) {
      this.stoppedAt.set(mode, Date.now());
    }
    this.modes = { ...this.modes, [mode]: toggle };
  }

  private rolls(mode: ChaosMode): boolean {
    const { enabled, intensity } = this.modes[mode];
    return enabled && Math.random() < intensity;
  }

  // Each mode reads its own intensity, so each has its own ceiling: a probability above one
  // is a typo, and a pause longer than half a minute is an outage rather than an experiment.
  private check(mode: ChaosMode, intensity: number): void {
    const ceiling =
      mode === 'latency_injection'
        ? MAX_DELAY_MS
        : mode === 'db_pause'
          ? MAX_PAUSE_SECONDS
          : 1;
    if (intensity < 0 || intensity > ceiling) {
      throw new BadRequestException(
        `${mode} takes an intensity between 0 and ${ceiling}`,
      );
    }
  }

  private async pauseDb(seconds: number): Promise<void> {
    if (this.pausedUntil !== null) {
      return;
    }
    const startedAt = Date.now();
    this.pausedUntil = startedAt + seconds * 1000;
    this.counters.pauses++;
    let down = false;

    try {
      await this.compose('pause');
      down = true;
      this.event('db_pause', true, { seconds, phase: 'paused' });
      await sleep(seconds * 1000);
      await this.compose('unpause');
      down = false;
      this.event(
        'db_pause',
        true,
        { seconds, phase: 'unpaused' },
        Date.now() - startedAt,
      );
    } catch (error: unknown) {
      this.lastError = error instanceof Error ? error.message : String(error);
      this.log.error('The challenge database could not be paused', error);
      this.event('db_pause', false, { seconds, message: this.lastError });
    } finally {
      // The mark is dropped only for a database that is back — either because the unpause
      // worked or because the pause never landed. An unpause that failed leaves it standing:
      // it is what `/chaos/state` answers with while the database is stuck, and what arms the
      // retry at shutdown. Clearing it there would hide a paused database and disarm the one
      // thing that would have put it back.
      if (!down) {
        this.pausedUntil = null;
      }
      this.switch('db_pause', off(seconds));
    }
  }

  // Fixed argument arrays and no shell: nothing a caller sends ever reaches a command line.
  // Protected because it is the one seam a test has: docker is not something a unit test can
  // run, and what is worth pinning is what the engine believes about the database afterwards.
  protected compose(action: 'pause' | 'unpause'): Promise<unknown> {
    return run('docker', ['compose', action, 'db'], { cwd: COMPOSE_DIR });
  }

  private event(
    mode: ChaosMode,
    ok: boolean,
    body: Record<string, unknown>,
    latencyMs = 0,
  ): void {
    this.attempts.record(chaosEvent(mode, ok, body, latencyMs));
  }
}
