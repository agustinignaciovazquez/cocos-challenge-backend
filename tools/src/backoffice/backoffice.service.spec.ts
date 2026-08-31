import { Logger } from '@nestjs/common';
import { ChaosService } from '../chaos/chaos.service';
import { GatewayResult, GatewayService } from '../gateway/gateway.service';
import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { SimulationService } from '../simulation/simulation.service';
import { Attempt, AttemptsStore } from '../store/attempts.store';
import { AnomaliesStore } from './anomalies.store';
import { DbOrder, Detector } from './anomaly';
import { BackofficeService } from './backoffice.service';
import { DETECTORS } from './detectors';
import { Reconciler } from './reconciler';

const secondsAgo = (seconds: number): string =>
  new Date(Date.now() - seconds * 1000).toISOString();

const placement = (over: Partial<Attempt> = {}): Omit<Attempt, 'id'> => ({
  at: secondsAgo(1),
  method: 'POST',
  path: '/orders',
  latencyMs: 5,
  status: 201,
  ok: true,
  sent: { userId: 1, instrumentId: 47, side: 'BUY', size: 10, type: 'MARKET' },
  expected: 'FILLED',
  actual: 'FILLED',
  ...over,
});

// A placement that never answered, old enough that the target's late-commit window has
// closed, carrying the key the database is asked for it by.
const lost = (secondsOld: number, idempotencyKey = 'k1'): Omit<Attempt, 'id'> =>
  placement({
    at: secondsAgo(secondsOld),
    latencyMs: 0,
    status: 0,
    ok: false,
    expected: 'UNKNOWN',
    actual: undefined,
    idempotencyKey,
  });

const user = (over: Partial<ShadowUserSnapshot> = {}): ShadowUserSnapshot => ({
  userId: 1,
  cash: '1000.00',
  seeded: true,
  uncertain: false,
  outstanding: 0,
  positions: [],
  ...over,
});

type Harness = {
  backoffice: BackofficeService;
  attempts: AttemptsStore;
  anomalies: AnomaliesStore;
  matchedKeys: () => string[];
  portfolioReads: () => number;
};

const build = (options: {
  byKey?: Record<string, DbOrder[]>;
  matchFails?: boolean;
  users?: ShadowUserSnapshot[] | (() => ShadowUserSnapshot[]);
  apiCash?: string;
  configureFails?: boolean;
}): Harness => {
  const attempts = new AttemptsStore();
  const anomalies = new AnomaliesStore(new ChaosService(attempts));
  const matchedKeys: string[] = [];
  let portfolioReads = 0;

  const gateway = {
    send: (): Promise<GatewayResult> => {
      portfolioReads++;
      return Promise.resolve({
        attemptId: 0,
        status: 200,
        ok: true,
        body: { availableCash: options.apiCash ?? '1000.00', positions: [] },
      });
    },
  } as unknown as GatewayService;

  const shadow = options.users ?? [user()];
  const simulation = {
    state: () => ({
      config: { running: false },
      shadow: { users: typeof shadow === 'function' ? shadow() : shadow },
    }),
    configure: () =>
      options.configureFails
        ? Promise.reject(new Error('sizeMin must not exceed sizeMax'))
        : Promise.resolve({}),
  } as unknown as SimulationService;

  const reconciler = {
    matchByKey: (_userId: number, key: string): Promise<DbOrder[]> => {
      matchedKeys.push(key);
      return options.matchFails
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve(options.byKey?.[key] ?? []);
    },
  } as unknown as Reconciler;

  return {
    backoffice: new BackofficeService(
      attempts,
      anomalies,
      gateway,
      simulation,
      reconciler,
    ),
    attempts,
    anomalies,
    matchedKeys: () => matchedKeys,
    portfolioReads: () => portfolioReads,
  };
};

const rules = (anomalies: AnomaliesStore): string[] =>
  anomalies.recent(100).map((anomaly) => anomaly.rule);

describe('BackofficeService', () => {
  // One of these drives the unreadable-database path on purpose, and its stack trace is
  // the expected result rather than a failure worth printing.
  beforeAll(() => {
    Logger.overrideLogger(false);
  });
  afterAll(() => {
    Logger.overrideLogger(true);
  });

  it('reports each attempt once however often it is swept', async () => {
    const { backoffice, attempts, anomalies } = build({});
    attempts.record(placement({ status: 500, ok: false }));

    await backoffice.sweep();
    await backoffice.sweep();

    expect(rules(anomalies)).toEqual(['http_5xx']);
  });

  // The engine annotates an attempt with the rules' expectation the instant its answer
  // lands, so a row read in that gap would look like an order nobody had an opinion on.
  it('holds back an attempt that has only just landed', async () => {
    const { backoffice, attempts, anomalies } = build({});
    attempts.record(
      placement({ at: new Date().toISOString(), latencyMs: 0, status: 500 }),
    );

    await backoffice.sweep();

    expect(rules(anomalies)).toEqual([]);
  });

  // A rule that throws is a bug worth surfacing, but it must cost the attempt a re-scan
  // rather than its only look — which is why the cursor advances after the loop, not
  // before it. Pushing onto the registry is also how a new rule joins the sweep.
  it('does not lose an attempt to a rule that threw', async () => {
    const { backoffice, attempts, anomalies } = build({});
    attempts.record(placement({ status: 500, ok: false }));
    const throws: Detector = () => {
      throw new Error('a rule with a bug in it');
    };

    DETECTORS.unshift(throws);
    try {
      await expect(backoffice.sweep()).rejects.toThrow('a rule with a bug');
    } finally {
      DETECTORS.shift();
    }
    await backoffice.sweep();

    expect(rules(anomalies)).toEqual(['http_5xx']);
  });

  it('leaves a lost order alone until the late-commit window has closed', async () => {
    const { backoffice, attempts, matchedKeys } = build({});
    attempts.record(lost(2));

    await backoffice.sweep();

    expect(matchedKeys()).toEqual([]);
  });

  it('asks the database once the window has closed and reports what it found', async () => {
    const { backoffice, attempts, anomalies, matchedKeys } = build({
      byKey: { k1: [{ id: 91, status: 'FILLED', at: secondsAgo(30) }] },
    });
    attempts.record(lost(30));

    await backoffice.sweep();

    expect(matchedKeys()).toEqual(['k1']);
    expect(rules(anomalies)).toEqual(['lost_order', 'http_5xx']);
    expect(anomalies.recent(1)[0].severity).toBe('warning');
  });

  // A database that cannot be read says nothing about whether the order landed, and
  // guessing is the one thing this rule must not do.
  it('keeps a candidate pending when the database cannot be read', async () => {
    const { backoffice, attempts, anomalies } = build({ matchFails: true });
    attempts.record(lost(30));

    await backoffice.sweep();
    const stats = await backoffice.stats();

    expect(rules(anomalies)).toEqual(['http_5xx']);
    expect(stats.reconciler).toMatchObject({
      pending: 1,
      lastError: 'connection refused',
    });
  });

  it('compares balances only once the run has placed enough orders', async () => {
    const { backoffice, attempts, anomalies } = build({ apiCash: '999.99' });
    for (let n = 0; n < 24; n++) {
      attempts.record(placement());
    }

    await backoffice.sweep();
    expect(rules(anomalies)).toEqual([]);

    attempts.record(placement());
    await backoffice.sweep();

    expect(rules(anomalies)).toEqual(['balance_drift']);
  });

  it('does not read a portfolio for a user it could not compare anyway', async () => {
    const { backoffice, attempts, anomalies, portfolioReads } = build({
      apiCash: '999.99',
      users: [user({ uncertain: true })],
    });
    for (let n = 0; n < 25; n++) {
      attempts.record(placement());
    }

    await backoffice.sweep();

    expect(portfolioReads()).toBe(0);
    expect(rules(anomalies)).toEqual([]);
  });

  // The shape match had to hand its one row to one of two identical losses and call the
  // other one an order that never landed. Two keys are two orders, and both are found.
  it('gives two identically shaped losses their own orders', async () => {
    const { backoffice, attempts, anomalies } = build({
      byKey: {
        k1: [{ id: 91, status: 'FILLED', at: secondsAgo(31) }],
        k2: [{ id: 92, status: 'FILLED', at: secondsAgo(30) }],
      },
    });
    attempts.record(lost(31, 'k1'));
    attempts.record(lost(30, 'k2'));

    await backoffice.sweep();

    const found = anomalies
      .recent(100)
      .filter((anomaly) => anomaly.rule === 'lost_order');

    expect(found.map((anomaly) => anomaly.severity)).toEqual([
      'warning',
      'warning',
    ]);
  });

  // Nothing is stored under the key, so nothing was placed under it: the one branch that
  // used to be a guess about a window is now the database's own answer.
  it('calls a key the database holds no order for never processed', async () => {
    const { backoffice, attempts, anomalies } = build({ byKey: {} });
    attempts.record(lost(30));

    await backoffice.sweep();

    expect(anomalies.recent(1)[0]).toMatchObject({
      rule: 'lost_order',
      severity: 'critical',
    });
  });

  // The probe's retry answered with the order the key names, so the row is acknowledged and
  // the report has to say the loss was recovered rather than that nobody heard of it.
  it('says a replayed order was recovered, not unacknowledged', async () => {
    const { backoffice, attempts, anomalies } = build({
      byKey: { k1: [{ id: 91, status: 'FILLED', at: secondsAgo(30) }] },
    });
    attempts.record(lost(30));
    attempts.record(
      placement({ at: secondsAgo(29), status: 200, orderId: 91 }),
    );

    await backoffice.sweep();

    const found = anomalies
      .recent(100)
      .find((anomaly) => anomaly.rule === 'lost_order');

    expect(found).toMatchObject({ severity: 'warning' });
    expect(found?.message).toContain('recovered, not lost');
    expect(found?.context.matched).toEqual([
      { id: 91, status: 'FILLED', at: secondsAgo(30), acknowledged: true },
    ]);
  });

  it('writes the threshold the rules read', async () => {
    const { backoffice, attempts, anomalies } = build({});
    attempts.record(placement({ latencyMs: 12 }));

    await backoffice.configure({ latencyThresholdMs: 1 });
    await backoffice.sweep();

    expect(rules(anomalies)).toEqual(['latency_high']);
    expect((await backoffice.stats()).config.latencyThresholdMs).toBe(1);
  });

  // A patch is one change or none: a 400 from the simulation knobs must not leave the
  // threshold moved behind it.
  it('leaves the threshold untouched when the rest of the patch is refused', async () => {
    const { backoffice } = build({ configureFails: true });

    await expect(
      backoffice.configure({ latencyThresholdMs: 1, sizeMin: 9, sizeMax: 2 }),
    ).rejects.toThrow('sizeMin must not exceed sizeMax');

    expect((await backoffice.stats()).config.latencyThresholdMs).toBe(500);
  });

  // A check that could hold neither side against the other has not happened, and must not
  // cost the run the next twenty-five orders before a balance is looked at again.
  it('keeps the comparison slot when it could not compare anybody', async () => {
    let uncertain = true;
    const { backoffice, attempts, anomalies } = build({
      apiCash: '999.99',
      users: () => [user({ uncertain })],
    });
    for (let n = 0; n < 25; n++) {
      attempts.record(placement());
    }

    await backoffice.sweep();
    expect(rules(anomalies)).toEqual([]);

    uncertain = false;
    await backoffice.sweep();

    expect(rules(anomalies)).toEqual(['balance_drift']);
  });
});
