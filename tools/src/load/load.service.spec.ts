import { ConflictException, NotFoundException } from '@nestjs/common';
import { AnomaliesStore } from '../backoffice/anomalies.store';
import { LedgerRow } from '../backoffice/anomaly';
import { BackofficeService } from '../backoffice/backoffice.service';
import { Reconciler } from '../backoffice/reconciler';
import { ChaosService } from '../chaos/chaos.service';
import { GatewayService } from '../gateway/gateway.service';
import { HistoryService } from '../history/history.service';
import { SimOrder } from '../order';
import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { Placement, SimulationService } from '../simulation/simulation.service';
import { AttemptsStore } from '../store/attempts.store';
import { LoadService } from './load.service';
import { RunResult } from './run';

const BMA = 31;

const shadowUser = (
  over: Partial<ShadowUserSnapshot> = {},
): ShadowUserSnapshot => ({
  userId: 1,
  cash: '1000.00',
  seeded: true,
  uncertain: false,
  outstanding: 0,
  positions: [],
  ...over,
});

const settle = async (result: RunResult): Promise<RunResult> => {
  const until = Date.now() + 5_000;
  while (result.phase !== 'done' && result.phase !== 'failed') {
    if (Date.now() > until) {
      throw new Error(`Run stuck in ${result.phase}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return result;
};

describe('LoadService', () => {
  let attempts: AttemptsStore;
  let anomalies: AnomaliesStore;
  let gateway: { sent: string[]; cancelStatus: number; cash: string[] };
  let simulation: {
    placed: SimOrder[];
    prepared: number[][];
    users: ShadowUserSnapshot[];
    preparedAtPhase: string[];
    onFirstPlacement?: () => void;
  };
  let reconciler: { extra: LedgerRow[]; mark: number };
  let load: LoadService;
  let history: {
    opened: string[];
    closed: { runId: string; summary: Record<string, unknown> }[];
  };
  let loadRunning: boolean[];
  let current: RunResult | null;
  let cancelled: Set<number>;

  const nextOrderId = (): number => 1_000 + simulation.placed.length;

  // The stub's database, built from what the stub's API actually accepted: a seed CASH_IN
  // the run did not write, then one row per placement. Nothing fills, so every fold stays
  // where the seed left it and a run that behaves has all five invariants holding.
  const ledgerRows = (): LedgerRow[] => {
    const seeded: LedgerRow = {
      id: 1,
      userId: 1,
      instrumentId: 66,
      side: 'CASH_IN',
      size: 1_000,
      price: '1.00',
      type: 'MARKET',
      status: 'FILLED',
    };
    const written = simulation.placed.map((order, at) => {
      const id = 1_001 + at;
      const resting = order.type === 'LIMIT';
      return {
        id,
        userId: order.userId,
        instrumentId: order.instrumentId,
        side: order.side,
        size: order.size,
        price: '1.00',
        type: order.type,
        status: cancelled.has(id) ? 'CANCELLED' : resting ? 'NEW' : 'REJECTED',
      };
    });
    return [seeded, ...reconciler.extra, ...written].sort(
      (a, b) => a.id - b.id,
    );
  };

  const build = (): LoadService => {
    attempts = new AttemptsStore();
    anomalies = new AnomaliesStore(new ChaosService(attempts));
    cancelled = new Set();

    // Successive portfolio reads answer down this queue, holding on the last, so a test can
    // put a balance that moves between the two readings the check makes.
    gateway = { sent: [], cancelStatus: 200, cash: ['1000.00'] };
    const gatewayStub = {
      send: (method: string, path: string) => {
        gateway.sent.push(`${method} ${path}`);
        const cancelling = path.endsWith('/cancel');
        const status = cancelling ? gateway.cancelStatus : 200;
        if (cancelling && status < 300) {
          cancelled.add(Number(path.split('/')[2]));
        }
        const attemptId = attempts.record({
          at: new Date().toISOString(),
          method,
          path,
          latencyMs: 4,
          status,
          ok: status < 300,
        });
        const balance =
          gateway.cash.length > 1 ? gateway.cash.shift() : gateway.cash[0];
        return Promise.resolve({
          attemptId,
          status,
          ok: status < 300,
          body: cancelling ? {} : { availableCash: balance },
        });
      },
    };

    simulation = {
      placed: [],
      prepared: [],
      users: [shadowUser()],
      preparedAtPhase: [],
    };
    const simulationStub = {
      place: (order: SimOrder): Promise<Placement> => {
        simulation.placed.push(order);
        if (simulation.placed.length === 1) {
          simulation.onFirstPlacement?.();
        }
        const id = nextOrderId();
        // Nothing fills, which is what keeps the stub's folds still: a resting order comes
        // back NEW and a market order is refused, and neither moves cash or shares.
        const status = order.type === 'LIMIT' ? 'NEW' : 'REJECTED';
        const attemptId = attempts.record({
          at: new Date().toISOString(),
          method: 'POST',
          path: '/orders',
          latencyMs: 7,
          status: 201,
          ok: true,
        });
        attempts.annotate(attemptId, { actual: status, orderId: id });
        return Promise.resolve({
          attemptId,
          status: 201,
          placed: { id, status, price: '1.00', size: order.size },
        });
      },
      prepare: (users: number[]): Promise<number> => {
        simulation.prepared.push(users);
        simulation.preparedAtPhase.push(current?.phase ?? 'none');
        return Promise.resolve(users.length);
      },
      state: () => ({ shadow: { users: simulation.users, prices: [] } }),
    };

    reconciler = { extra: [], mark: 500 };
    const reconcilerStub = {
      highWaterMark: () => Promise.resolve(reconciler.mark),
      ledger: () => Promise.resolve(ledgerRows()),
    };

    loadRunning = [];
    const backofficeStub = {
      setLoadRunning: (running: boolean) => loadRunning.push(running),
    };

    history = { opened: [], closed: [] };
    const historyStub = {
      open: (mode: string) => {
        history.opened.push(mode);
        return `run-${history.opened.length}`;
      },
      close: (runId: string, summary: Record<string, unknown>) =>
        history.closed.push({ runId, summary }),
    };

    return new LoadService(
      gatewayStub as unknown as GatewayService,
      simulationStub as unknown as SimulationService,
      reconcilerStub as unknown as Reconciler,
      anomalies,
      attempts,
      backofficeStub as unknown as BackofficeService,
      historyStub as unknown as HistoryService,
    );
  };

  const run = async (overrides = {}): Promise<RunResult> => {
    current = load.start({ totalOrders: 4, concurrency: 2, ...overrides });
    return settle(current);
  };

  beforeEach(() => {
    current = null;
    load = build();
  });

  it('answers with a run that is still placing and finishes it in the background', async () => {
    const started = load.start({ totalOrders: 4, concurrency: 2 });
    expect(started.phase).toBe('placing');
    expect(started.finishedAt).toBeNull();
    expect(load.state().running).toBe(true);

    current = started;
    await settle(started);
    expect(started.phase).toBe('done');
    expect(started.finishedAt).not.toBeNull();
    expect(load.state().running).toBe(false);
  });

  it('refuses a second run while one is in flight', () => {
    current = load.start({ totalOrders: 4, concurrency: 2 });
    expect(() => load.start({})).toThrow(ConflictException);
  });

  it('opens a history run under its own id and closes it with the result', async () => {
    const result = await run({ mode: 'ramp' });

    expect(history.opened).toEqual(['load-ramp']);
    expect(result.runId).toBe('run-1');
    expect(history.closed).toEqual([
      { runId: 'run-1', summary: { ...result } },
    ]);
  });

  it('closes the history run of a run that failed', async () => {
    (load as unknown as { reconciler: { ledger: unknown } }).reconciler.ledger =
      () => Promise.reject(new Error('the database is gone'));
    const result = await run();

    expect(result.phase).toBe('failed');
    expect(history.closed).toEqual([
      { runId: 'run-1', summary: { ...result } },
    ]);
  });

  it('keeps the knobs a request left out', async () => {
    await run({ mode: 'contention', totalOrders: 4 });
    const second = await run({ totalOrders: 2 });
    expect(second.profile.mode).toBe('contention');
    expect(second.profile.totalOrders).toBe(2);
  });

  it('hands back a run by id and refuses one it never held', async () => {
    const result = await run();
    expect(load.result(result.runId).sent).toBe(4);
    expect(() => load.result('run-nothing')).toThrow(NotFoundException);
  });

  it('counts the shed load apart from the failures', async () => {
    const result = await run();
    expect(result.sent).toBe(4);
    expect(result.byStatus).toEqual({ '201': 4 });
    expect(result.shedding).toBe(0);
    expect(result.unanswered).toBe(0);
    expect(result.latencyMs).toEqual({ p50: 7, p95: 7, max: 7, samples: 4 });
  });

  // The mark has to be read before anything is placed, or the run's own rows would fall
  // outside the window that is supposed to hold exactly them.
  it('marks the database before it seeds and seeds before it places', async () => {
    await run();
    expect(simulation.preparedAtPhase[0]).toBe('placing');
  });

  it('waits for the users to go still before it checks anything', async () => {
    simulation.users = [shadowUser({ outstanding: 2 })];
    let polls = 0;
    const state = () => {
      if (++polls > 3) {
        simulation.users = [shadowUser({ outstanding: 0 })];
      }
      return { shadow: { users: simulation.users, prices: [] } };
    };
    (load as unknown as { simulation: { state: unknown } }).simulation.state =
      state;

    const result = await run();
    expect(result.quiesce?.timedOut).toBe(false);
    expect(result.quiesce?.outstanding).toEqual([
      { userId: 1, outstanding: 0 },
    ]);
  });

  // A shadow read back from the API agrees with it by construction, so re-seeding before the
  // check would replace the evidence with a tautology.
  it('re-seeds only after the invariants have been checked', async () => {
    await run();
    expect(simulation.preparedAtPhase).toEqual(['placing', 'checking']);
  });

  it('records a failing invariant as a critical anomaly against the run', async () => {
    // A purchase the seed could not afford, before the run window so only the two folds it
    // actually breaks are the ones reported.
    reconciler.extra = [
      {
        id: 2,
        userId: 1,
        instrumentId: BMA,
        side: 'BUY',
        size: 1,
        price: '2000.00',
        type: 'MARKET',
        status: 'FILLED',
      },
    ];
    const result = await run();

    const failed = result.invariants.filter(({ pass }) => !pass);
    expect(failed.map(({ name }) => name)).toEqual([
      'conservation',
      'no_overdraft',
    ]);
    const recorded = anomalies.recent(10);
    expect(recorded.length).toBe(2);
    expect(recorded[0].rule).toBe('invariant_violation');
    expect(recorded[0].severity).toBe('critical');
    expect(recorded[0].context.runId).toBe(result.runId);
  });

  // The recorder holds the newest five thousand calls, so a run bigger than that has pushed
  // its own first orders out of the ring by the time it checks anything. Those rows are still
  // its own, and reading them as orders nobody answered for is how a clean run reports a
  // critical against the target for the harness's own forgetfulness.
  it('remembers the orders it was answered for after the recorder has moved past them', async () => {
    const held = attempts.recent.bind(attempts);
    jest
      .spyOn(attempts, 'recent')
      .mockImplementation((limit: number) =>
        current?.phase === 'checking' ? [] : held(limit),
      );

    const result = await run();
    const agreement = result.invariants.find(
      ({ name }) => name === 'response_db_agreement',
    );
    expect(agreement?.pass).toBe(true);
    expect(agreement?.detail).toContain('4 acknowledged, 0 unmatched');
  });

  it('folds each wave out of the recorder before the ring can move past it', async () => {
    const held = attempts.recent.bind(attempts);
    // A ring that only ever holds one wave: the totals are right only if each wave is read
    // as it settles rather than all of them at the end.
    jest
      .spyOn(attempts, 'recent')
      .mockImplementation((limit: number) => held(limit).slice(0, 2));

    const result = await run({ totalOrders: 6, concurrency: 2 });
    expect(result.sent).toBe(6);
    expect(result.byStatus).toEqual({ '201': 6 });
    expect(result.latencyMs.samples).toBe(6);
  });

  // The balance and the rows behind it are separate round trips, and after a quiesce that
  // timed out there are still orders able to land between them. Without the second reading
  // the stale balance is held against a fresher fold and a clean target takes the blame.
  it('skips the API leg when the balance moved across the ledger read', async () => {
    gateway.cash = ['1000.00', '900.00'];
    reconciler.extra = [
      {
        id: 2,
        userId: 1,
        instrumentId: BMA,
        side: 'BUY',
        size: 1,
        price: '100.00',
        type: 'MARKET',
        status: 'FILLED',
      },
    ];

    const result = await run();
    const conservation = result.invariants.find(
      ({ name }) => name === 'conservation',
    );
    expect(conservation?.pass).toBe(true);
    expect(conservation?.detail).toContain('API leg not comparable');
    expect(anomalies.size()).toBe(0);
  });

  // A target that stopped answering has not broken conservation, it has left it unchecked.
  // The outage is already 5000 http_5xx criticals and the run's own unanswered count.
  it('skips the API leg when the target could not be read at all', async () => {
    (load as unknown as { gateway: { send: unknown } }).gateway.send =
      (): Promise<unknown> =>
        Promise.resolve({
          attemptId: attempts.record({
            at: new Date().toISOString(),
            method: 'GET',
            path: '/users/1/portfolio',
            latencyMs: 10_000,
            status: 0,
            ok: false,
          }),
          status: 0,
          ok: false,
          body: { message: 'fetch failed' },
        });

    const result = await run();
    const conservation = result.invariants.find(
      ({ name }) => name === 'conservation',
    );
    expect(conservation?.pass).toBe(true);
    expect(conservation?.detail).toContain('the API balance could not be read');
    expect(anomalies.size()).toBe(0);
  });

  // A row in the run window can belong to a client this run knows nothing about. Counting
  // only the run's own losses reports a simulation order that timed out as a phantom.
  it('allows for a placement another client lost during the run', async () => {
    simulation.onFirstPlacement = () => {
      attempts.record({
        at: new Date().toISOString(),
        method: 'POST',
        path: '/orders',
        latencyMs: 10_000,
        status: 0,
        ok: false,
        sent: { userId: 1, instrumentId: BMA, side: 'BUY', size: 1 },
      });
    };
    reconciler.extra = [
      {
        id: 501,
        userId: 1,
        instrumentId: BMA,
        side: 'BUY',
        size: 1,
        price: '100.00',
        type: 'MARKET',
        status: 'REJECTED',
      },
    ];

    const result = await run();
    const agreement = result.invariants.find(
      ({ name }) => name === 'response_db_agreement',
    );
    expect(agreement?.pass).toBe(true);
    expect(agreement?.detail).toContain('1 unmatched against 1 unanswered');
  });

  // An attempt the ring dropped before it could be folded is unaccounted for in both
  // directions at once, so it has to widen the allowance rather than narrow it.
  it('allows for its own attempts the recorder dropped before folding', async () => {
    const held = attempts.recent.bind(attempts);
    jest
      .spyOn(attempts, 'recent')
      .mockImplementation((limit: number) =>
        current?.phase === 'placing' ? [] : held(limit),
      );
    reconciler.extra = [
      {
        id: 501,
        userId: 1,
        instrumentId: BMA,
        side: 'BUY',
        size: 1,
        price: '100.00',
        type: 'MARKET',
        status: 'REJECTED',
      },
    ];

    const result = await run();
    const agreement = result.invariants.find(
      ({ name }) => name === 'response_db_agreement',
    );
    expect(agreement?.pass).toBe(true);
    expect(agreement?.detail).toContain('1 unmatched against 4 unanswered');
  });

  it('records nothing when every invariant holds', async () => {
    const result = await run();
    expect(result.invariants.every(({ pass }) => pass)).toBe(true);
    expect(anomalies.size()).toBe(0);
  });

  it('cancels a resting order it placed, and counts what came back', async () => {
    const result = await run({
      mode: 'contention',
      cancelMix: 0.5,
      totalOrders: 4,
      concurrency: 1,
    });
    expect(
      simulation.placed.filter((order) => order.type === 'LIMIT').length,
    ).toBe(2);
    expect(gateway.sent).toContain('PATCH /orders/1001/cancel');
    expect(result.cancels).toEqual({
      requested: 2,
      cancelled: 2,
      conflicted: 0,
    });
  });

  it('counts a refused cancel as a conflict, not as a cancellation', async () => {
    gateway.cancelStatus = 409;
    const result = await run({
      mode: 'contention',
      cancelMix: 0.5,
      totalOrders: 4,
      concurrency: 1,
    });
    expect(result.cancels).toEqual({
      requested: 2,
      cancelled: 0,
      conflicted: 2,
    });
  });

  // The first wave of a contention run has nothing resting yet, so the cancel step has to
  // place one instead or the run would send fewer orders than it was asked for.
  it('places a resting order when a cancel finds nothing to cancel', async () => {
    const result = await run({
      mode: 'contention',
      cancelMix: 0.5,
      totalOrders: 4,
      concurrency: 4,
    });
    expect(result.sent).toBe(4);
    expect(result.cancels.requested).toBe(0);
    expect(
      simulation.placed.filter((order) => order.type === 'LIMIT').length,
    ).toBe(4);
  });

  it('leaves a shadow it cannot trust out of the conservation check', async () => {
    simulation.users = [shadowUser({ uncertain: true })];
    const result = await run();
    const conservation = result.invariants.find(
      ({ name }) => name === 'conservation',
    );
    expect(conservation?.pass).toBe(true);
    expect(conservation?.detail).toContain('shadow leg not comparable');
  });

  it('reports a run that could not be finished rather than taking the harness down', async () => {
    (load as unknown as { reconciler: { ledger: unknown } }).reconciler.ledger =
      () => Promise.reject(new Error('the database is gone'));
    const result = await run();
    expect(result.phase).toBe('failed');
    expect(result.error).toBe('the database is gone');
    expect(load.state().running).toBe(false);
  });
});
