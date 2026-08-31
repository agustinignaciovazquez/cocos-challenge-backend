import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  Logger,
  OnModuleDestroy,
} from '@nestjs/common';
import { GatewayService } from '../gateway/gateway.service';
import { HistoryService } from '../history/history.service';
import { MarketOrder, SimOrder } from '../order';
import { Attempt, AttemptsStore } from '../store/attempts.store';
import {
  Execution,
  SeedPortfolio,
  ShadowLedger,
  ShadowSnapshot,
} from './shadow-ledger';
import { StartSimulationDto } from './start-simulation.dto';

// The seed's liquid tickers — PAMP, METR, BMA, LOMA, GGAL, YPFD, ALUA — every one of
// which carries market data. Ids are fixed here rather than looked up because the search
// endpoint does not return prices and the engine must never read the database: it learns
// each price from the API's own order responses, the way any client would.
export const TRADABLE_INSTRUMENTS = [47, 54, 31, 45, 34, 50, 61];

export type SimulationConfig = {
  ratePerSec: number;
  users: number[];
  buyRatio: number;
  sizeMin: number;
  sizeMax: number;
  running: boolean;
};

export type SimulationCounters = {
  sent: number;
  filled: number;
  rejected: number;
  failed: number;
  attempts: number;
};

export type SimulationState = {
  config: SimulationConfig;
  counters: SimulationCounters;
  shadow: ShadowSnapshot;
};

export type PlacedOrder = Execution & { id: number; size: number };

// What one placement is worth to a caller that is not the loop: the recorder's row, the
// transport outcome, and whatever order the target says it created.
export type Placement = {
  attemptId: number;
  status: number;
  placed?: PlacedOrder;
};

const asPlacedOrder = (body: unknown): PlacedOrder | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { id, status, price, size } = body as Partial<PlacedOrder>;
  return typeof id === 'number' &&
    typeof status === 'string' &&
    typeof price === 'string' &&
    typeof size === 'number'
    ? { id, status, price, size }
    : undefined;
};

const asPortfolio = (body: unknown): SeedPortfolio | undefined => {
  if (typeof body !== 'object' || body === null) {
    return undefined;
  }
  const { availableCash, positions } = body as Partial<SeedPortfolio>;
  return typeof availableCash === 'string' && Array.isArray(positions)
    ? { availableCash, positions }
    : undefined;
};

const pick = <T>(values: T[]): T =>
  values[Math.floor(Math.random() * values.length)];

@Injectable()
export class SimulationService implements OnModuleDestroy {
  private readonly log = new Logger(SimulationService.name);
  private config: SimulationConfig = {
    ratePerSec: 1,
    users: [1, 2, 3, 4],
    buyRatio: 0.6,
    sizeMin: 1,
    sizeMax: 50,
    running: false,
  };
  private counters: Omit<SimulationCounters, 'attempts'> = {
    sent: 0,
    filled: 0,
    rejected: 0,
    failed: 0,
  };
  private readonly ledger = new ShadowLedger();
  private readonly reseeding = new Set<number>();
  private timer?: NodeJS.Timeout;
  // The history run this start→stop window is being written into, if the window is open, and
  // where the loop's lifetime tally stood when it opened.
  private runId?: string;
  private opened = { sent: 0, filled: 0, rejected: 0, failed: 0 };

  constructor(
    private readonly gateway: GatewayService,
    private readonly attempts: AttemptsStore,
    private readonly history: HistoryService,
  ) {}

  async start(overrides: StartSimulationDto): Promise<SimulationState> {
    // Named one by one rather than spread: a DTO declares every optional knob as an own
    // property, so spreading one that omitted them overwrites the defaults with undefined.
    const config: SimulationConfig = {
      ratePerSec: overrides.ratePerSec ?? this.config.ratePerSec,
      users: overrides.users ?? this.config.users,
      buyRatio: overrides.buyRatio ?? this.config.buyRatio,
      sizeMin: overrides.sizeMin ?? this.config.sizeMin,
      sizeMax: overrides.sizeMax ?? this.config.sizeMax,
      running: false,
    };
    if (config.sizeMin > config.sizeMax) {
      throw new BadRequestException('sizeMin must not exceed sizeMax');
    }

    // The loop stays down across the seed so no tick can read a half-built shadow.
    this.clearTimer();
    this.closeWindow();
    this.config = config;
    // Open before the seed: the portfolios the shadow is built from are the first thing an
    // offline reader has to be able to check the rest of the window against.
    this.runId = this.history.open('sim', { simulation: config });
    this.opened = { ...this.counters };
    if ((await this.seedAll()) === 0) {
      this.closeWindow();
      throw new BadGatewayException(
        `The simulation cannot run without a shadow: no portfolio could be read for any of users ${config.users.join(', ')}`,
      );
    }

    this.config = { ...config, running: true };
    this.run();
    return this.state();
  }

  stop(): SimulationState {
    this.clearTimer();
    this.config = { ...this.config, running: false };
    this.closeWindow();
    return this.state();
  }

  // A start→stop window is a run: it gets a directory of its own, and what the loop made of
  // it — the counters and the shadow it evolved — is the summary written when it closes.
  //
  // The counters are the window's own, not the loop's lifetime tally: the manifest describes
  // one window, and its numbers have to be countable against the rows in its own files.
  private closeWindow(): void {
    if (this.runId === undefined) {
      return;
    }
    const { sent, filled, rejected, failed } = this.counters;
    this.history.close(this.runId, {
      counters: {
        sent: sent - this.opened.sent,
        filled: filled - this.opened.filled,
        rejected: rejected - this.opened.rejected,
        failed: failed - this.opened.failed,
      },
      shadow: this.ledger.snapshot(),
    });
    this.runId = undefined;
  }

  // The one way in for the back-office's `PATCH /backoffice/config`: the knobs are written
  // here rather than onto the object `state()` hands out, so a caller cannot change the
  // rate without the loop being rebuilt at it, or the users without a shadow to match.
  async configure(overrides: StartSimulationDto): Promise<SimulationConfig> {
    const config: SimulationConfig = {
      ratePerSec: overrides.ratePerSec ?? this.config.ratePerSec,
      users: overrides.users ?? this.config.users,
      buyRatio: overrides.buyRatio ?? this.config.buyRatio,
      sizeMin: overrides.sizeMin ?? this.config.sizeMin,
      sizeMax: overrides.sizeMax ?? this.config.sizeMax,
      running: this.config.running,
    };
    if (config.sizeMin > config.sizeMax) {
      throw new BadRequestException('sizeMin must not exceed sizeMax');
    }

    const sameUsers =
      config.users.length === this.config.users.length &&
      config.users.every((userId, at) => userId === this.config.users[at]);

    // Down for the whole change: a tick must never read a half-built shadow, and a new
    // rate only takes effect on a fresh interval.
    this.clearTimer();
    this.config = config;
    if (!sameUsers) {
      await this.seedAll();
    }
    if (config.running) {
      this.run();
    }
    return { ...this.config };
  }

  async reset(): Promise<SimulationState> {
    this.clearTimer();
    this.counters = { sent: 0, filled: 0, rejected: 0, failed: 0 };
    this.opened = { ...this.counters };
    await this.seedAll();
    if (this.config.running) {
      this.run();
    }
    return this.state();
  }

  // The load engine drives this same shadow, so the users it is about to hammer have to be
  // in it and freshly read. Seeding is a whole-shadow act — the generation bump is what
  // makes a settle from the shadow being replaced harmless — so the loop comes down for it,
  // exactly as it does for a start.
  //
  // The guest users are given a shadow and nothing else. Writing them into `users` would
  // enrol them in the loop's own rotation for the rest of the session and report a config
  // the operator never asked for, so a load run on user 4 would leave the simulation trading
  // user 4 forever.
  async prepare(userIds: number[]): Promise<number> {
    this.clearTimer();
    const seeded = await this.seedUsers([
      ...new Set([...this.config.users, ...userIds]),
    ]);
    if (this.config.running) {
      this.run();
    }
    return seeded;
  }

  state(): SimulationState {
    return {
      config: this.config,
      counters: { ...this.counters, attempts: this.attempts.size() },
      shadow: this.ledger.snapshot(),
    };
  }

  onModuleDestroy(): void {
    this.clearTimer();
  }

  private run(): void {
    this.timer = setInterval(
      () =>
        void this.tick().catch((error: unknown) =>
          this.log.error('A simulated order could not be sent', error),
        ),
      Math.round(1000 / this.config.ratePerSec),
    );
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  private seedAll(): Promise<number> {
    return this.seedUsers(this.config.users);
  }

  private async seedUsers(users: number[]): Promise<number> {
    this.ledger.reseed(users);
    const generation = this.ledger.generation;
    const seeded = await Promise.all(
      users.map((userId) => this.seedUser(generation, userId)),
    );
    return seeded.filter((ok) => ok).length;
  }

  private async seedUser(generation: number, userId: number): Promise<boolean> {
    const result = await this.gateway.send('GET', `/users/${userId}/portfolio`);
    const portfolio = result.ok ? asPortfolio(result.body) : undefined;
    return portfolio !== undefined
      ? this.ledger.seed(generation, userId, portfolio)
      : false;
  }

  private async tick(): Promise<void> {
    this.count(await this.place(this.nextOrder()));
  }

  // The counters say what the loop did, so the loop is what moves them. The shadow and the
  // recorder are shared with the load engine on purpose — one bookkeeping, one set of rows —
  // but a run of five thousand shed placements is not five thousand simulation failures, and
  // the runner keeps its own tally of those.
  private count({ placed }: Placement): void {
    this.counters.sent++;
    if (placed === undefined) {
      this.counters.failed++;
    } else if (placed.status === 'FILLED') {
      this.counters.filled++;
    } else if (placed.status === 'REJECTED') {
      this.counters.rejected++;
    }
  }

  // The one path an order takes to the target, whether the loop sent it or the load engine
  // did: one reserve against the shadow, one recorded call, one settle. A second bookkeeping
  // would be a second answer to the question the harness exists to answer.
  async place(order: SimOrder): Promise<Placement> {
    // The expectation is taken from the shadow as it stands before the send, and what the
    // order would consume is held aside until the response settles it.
    const reservation = this.ledger.reserve(order);

    const result = await this.gateway.send('POST', '/orders', this.body(order));
    const placed = result.ok ? asPlacedOrder(result.body) : undefined;

    if (result.status === 0) {
      this.ledger.lose(reservation);
    } else {
      this.ledger.settle(reservation, placed);
    }

    // The recorder is annotated whoever sent the order: the rules read these rows, and a
    // detector must not be able to tell the loop's orders from the load engine's.
    const annotation: Partial<Attempt> = {
      expected: reservation.expectation,
    };
    if (placed !== undefined) {
      annotation.actual = placed.status;
      annotation.orderId = placed.id;
    }
    this.attempts.annotate(result.attemptId, annotation);

    if (this.ledger.needsReseed(order.userId)) {
      this.reseed(order.userId);
    }
    return { attemptId: result.attemptId, status: result.status, placed };
  }

  // Money is a string everywhere inside the sim; the target's DTO wants a number on the
  // wire, and this is the one place that conversion happens.
  private body(order: SimOrder): Record<string, unknown> {
    return order.type === 'LIMIT'
      ? { ...order, price: Number(order.price) }
      : { ...order };
  }

  // A shadow the engine stopped trusting is worth nothing until it is read back, and a
  // long run has to heal itself rather than fall silent for the rest of the session. One
  // re-read at a time per user, so a target that stays down is probed, not hammered.
  private reseed(userId: number): void {
    if (this.reseeding.has(userId)) {
      return;
    }
    this.reseeding.add(userId);
    void this.seedUser(this.ledger.generation, userId)
      .catch((error: unknown) =>
        this.log.error(
          `Could not re-read the portfolio of user ${userId}`,
          error,
        ),
      )
      .finally(() => this.reseeding.delete(userId));
  }

  private nextOrder(): MarketOrder {
    const { users, buyRatio, sizeMin, sizeMax } = this.config;
    return {
      userId: pick(users),
      instrumentId: pick(TRADABLE_INSTRUMENTS),
      side: Math.random() < buyRatio ? 'BUY' : 'SELL',
      size: sizeMin + Math.floor(Math.random() * (sizeMax - sizeMin + 1)),
      type: 'MARKET',
    };
  }
}
