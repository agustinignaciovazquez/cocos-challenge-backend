import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { Attempt } from '../store/attempts.store';
import { MatchedOrder } from './anomaly';
import {
  driftFindings,
  http5xx,
  latencyHigh,
  lostCandidate,
  lostOrder,
  reconcilableAt,
  unexpectedShedding,
  unexpectedStatus,
} from './detectors';

const AT = '2026-08-26T12:00:00.000Z';

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 7,
  at: AT,
  method: 'POST',
  path: '/orders',
  latencyMs: 12,
  status: 201,
  ok: true,
  sent: { userId: 1, instrumentId: 47, side: 'BUY', size: 10, type: 'MARKET' },
  idempotencyKey: 'e4a1',
  ...over,
});

const config = { latencyThresholdMs: 500 };

const row = (over: Partial<MatchedOrder> = {}): MatchedOrder => ({
  id: 300,
  status: 'FILLED',
  at: AT,
  acknowledged: false,
  ...over,
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

describe('latency_high', () => {
  it('says nothing about a call inside the threshold', () => {
    expect(latencyHigh(attempt({ latencyMs: 500 }), config)).toBeUndefined();
  });

  it('warns one millisecond past it', () => {
    expect(latencyHigh(attempt({ latencyMs: 501 }), config)).toMatchObject({
      rule: 'latency_high',
      severity: 'warning',
      context: { latencyMs: 501, latencyThresholdMs: 500 },
    });
  });

  it('follows the threshold it is given rather than a fixed one', () => {
    expect(
      latencyHigh(attempt({ latencyMs: 12 }), { latencyThresholdMs: 1 }),
    ).toMatchObject({ rule: 'latency_high' });
  });

  it('leaves a call that never answered to http_5xx', () => {
    expect(
      latencyHigh(attempt({ status: 0, ok: false, latencyMs: 10_000 }), config),
    ).toBeUndefined();
  });
});

describe('http_5xx', () => {
  it('ignores a success and a client error alike', () => {
    expect(http5xx(attempt({ status: 201 }), config)).toBeUndefined();
    expect(
      http5xx(attempt({ status: 404, ok: false }), config),
    ).toBeUndefined();
  });

  it('reports a server error as critical', () => {
    expect(http5xx(attempt({ status: 500, ok: false }), config)).toMatchObject({
      rule: 'http_5xx',
      severity: 'critical',
      context: { status: 500 },
    });
  });

  // The target sheds load with a 503 by design, and a run that provokes thousands of them
  // would bury every real fault under the API working exactly as documented.
  it('leaves the documented load-shedding to unexpected_shedding', () => {
    expect(
      http5xx(attempt({ status: 503, ok: false }), config),
    ).toBeUndefined();
  });

  it('reports the recorder mark for an answer that never came', () => {
    const finding = http5xx(
      attempt({ status: 0, ok: false, body: { message: 'fetch failed' } }),
      config,
    );

    expect(finding).toMatchObject({ rule: 'http_5xx', severity: 'critical' });
    expect(finding?.message).toContain('never answered: fetch failed');
  });

  // Five hundred anomalies must not be able to hold five hundred error pages.
  it('keeps a small body whole and truncates one that is not', () => {
    const small = { message: 'Internal server error' };

    expect(
      http5xx(attempt({ status: 500, ok: false, body: small }), config)?.context
        .body,
    ).toEqual(small);

    const truncated = http5xx(
      attempt({ status: 500, ok: false, body: 'x'.repeat(4000) }),
      config,
    )?.context.body as string;

    expect(truncated.length).toBeLessThan(600);
    expect(truncated).toContain('(4000 characters)');
  });
});

describe('unexpected_shedding', () => {
  const shed = attempt({ status: 503, ok: false });
  const quiet = (secondsBefore: number) => ({
    ...config,
    quietSince: Date.parse(AT) - secondsBefore * 1000,
  });

  it('warns about a 503 that arrived after the harness fell quiet', () => {
    expect(unexpectedShedding(shed, quiet(1))).toMatchObject({
      rule: 'unexpected_shedding',
      severity: 'warning',
      context: { status: 503 },
    });
  });

  // Everything a run sheds is shedding it asked for, and the mark is what tells the two
  // apart: a 503 from before the harness was seen idle belongs to whatever was driving then.
  it('says nothing about a 503 from before the quiet began', () => {
    expect(unexpectedShedding(shed, quiet(-1))).toBeUndefined();
  });

  it('says nothing at all while something is driving the target', () => {
    expect(unexpectedShedding(shed, { ...config, quietSince: null })).toBe(
      undefined,
    );
    expect(unexpectedShedding(shed, config)).toBeUndefined();
  });

  it('ignores every status but the one the target sheds with', () => {
    expect(
      unexpectedShedding(attempt({ status: 500, ok: false }), quiet(1)),
    ).toBeUndefined();
    expect(unexpectedShedding(attempt({ status: 201 }), quiet(1))).toBe(
      undefined,
    );
  });
});

describe('unexpected_status', () => {
  it('says nothing when the API decided what the rules said', () => {
    expect(
      unexpectedStatus(
        attempt({ expected: 'FILLED', actual: 'FILLED' }),
        config,
      ),
    ).toBeUndefined();
  });

  it('reports a disagreement as critical', () => {
    expect(
      unexpectedStatus(
        attempt({ expected: 'REJECTED', actual: 'FILLED', orderId: 91 }),
        config,
      ),
    ).toMatchObject({
      rule: 'unexpected_status',
      severity: 'critical',
      context: { expected: 'REJECTED', actual: 'FILLED', orderId: 91 },
    });
  });

  it('holds its tongue when the engine had no opinion', () => {
    expect(
      unexpectedStatus(
        attempt({ expected: 'UNKNOWN', actual: 'FILLED' }),
        config,
      ),
    ).toBeUndefined();
  });

  it('holds its tongue when the order got no answer to compare', () => {
    expect(
      unexpectedStatus(attempt({ expected: 'FILLED', status: 0 }), config),
    ).toBeUndefined();
  });

  it('ignores a call the engine never placed', () => {
    expect(unexpectedStatus(attempt({ path: '/instruments' }), config)).toBe(
      undefined,
    );
  });
});

describe('lost_order', () => {
  const lost = attempt({ status: 0, ok: false, latencyMs: 10_000 });

  it('calls an order with no row at all sent but never processed', () => {
    expect(lostOrder(lost, [])).toMatchObject({
      rule: 'lost_order',
      severity: 'critical',
    });
    expect(lostOrder(lost, [])?.message).toContain('sent but never processed');
  });

  it('calls a row nobody was told about processed but unacknowledged', () => {
    const finding = lostOrder(lost, [row({ id: 412, status: 'FILLED' })]);

    expect(finding).toMatchObject({ rule: 'lost_order', severity: 'warning' });
    expect(finding?.message).toContain('412 (FILLED)');
    expect(finding?.message).toContain('processed but unacknowledged');
  });

  // The key found this attempt's own order, and an attempt carrying that id is the retry
  // that replayed it. Nothing is unaccounted for, so it is neither critical nor unheard of.
  it('calls a row the retry replayed recovered rather than lost', () => {
    const finding = lostOrder(lost, [
      row({ id: 412, status: 'FILLED', acknowledged: true }),
    ]);

    expect(finding).toMatchObject({ rule: 'lost_order', severity: 'warning' });
    expect(finding?.message).toContain('recovered, not lost');
    expect(finding?.context.matched).toEqual([
      row({ id: 412, status: 'FILLED', acknowledged: true }),
    ]);
  });
});

describe('lost-order candidates', () => {
  it('takes a placement that never answered', () => {
    expect(lostCandidate(attempt({ status: 0, ok: false }))).toEqual({
      userId: 1,
      idempotencyKey: 'e4a1',
    });
  });

  // The database is asked by key, so there is nothing to ask with without one.
  it('leaves a placement that carried no key alone', () => {
    expect(
      lostCandidate(
        attempt({ status: 0, ok: false, idempotencyKey: undefined }),
      ),
    ).toBeUndefined();
  });

  it('leaves an answered placement alone', () => {
    expect(lostCandidate(attempt({ status: 201 }))).toBeUndefined();
  });

  // The target answering 503 is the target saying it rolled the placement back.
  it('leaves a definitive server error alone', () => {
    expect(lostCandidate(attempt({ status: 503, ok: false }))).toBeUndefined();
  });

  it('leaves a failed call that was not a placement alone', () => {
    expect(
      lostCandidate(
        attempt({ status: 0, ok: false, method: 'GET', path: '/orders' }),
      ),
    ).toBeUndefined();
  });

  it('cannot match a payload it does not recognise', () => {
    expect(
      lostCandidate(attempt({ status: 0, ok: false, sent: { userId: 1 } })),
    ).toBeUndefined();
  });

  // 5s waiting for a connection plus a 10s transaction is the target's ceiling, measured
  // from its handler, plus a second of transit. What the client waited does not enter it.
  it('waits sixteen seconds past the send, whatever the gateway waited', () => {
    expect(reconcilableAt(attempt({ status: 0, latencyMs: 10_000 }))).toBe(
      Date.parse('2026-08-26T12:00:16.000Z'),
    );
    expect(reconcilableAt(attempt({ status: 0, latencyMs: 5 }))).toBe(
      Date.parse('2026-08-26T12:00:16.000Z'),
    );
  });
});

describe('balance_drift', () => {
  const cash = (value: string): Map<number, string> => new Map([[1, value]]);

  // Skipping a user is not the same as clearing it: `compared` is what the caller needs
  // to know whether the check happened at all.
  const skipped = { compared: 0, findings: [] };

  it('says nothing when the shadow and the API agree exactly', () => {
    expect(driftFindings([user()], [user()], cash('1000.00'))).toEqual({
      compared: 1,
      findings: [],
    });
  });

  it('reports a mismatch as critical with both values', () => {
    expect(driftFindings([user()], [user()], cash('999.99'))).toEqual({
      compared: 1,
      findings: [
        {
          rule: 'balance_drift',
          severity: 'critical',
          message:
            'User 1 cash drifted: the shadow says 1000.00, the API says 999.99',
          context: { userId: 1, shadow: '1000.00', api: '999.99' },
        },
      ],
    });
  });

  it('compares as exact strings, not as numbers', () => {
    expect(
      driftFindings([user()], [user()], cash('1000.0')).findings,
    ).toHaveLength(1);
  });

  // The engine suppresses an uncertain user's expectations by design; alarming on one
  // would report the harness's own blind spot as a bug in the target.
  it('skips a user the engine stopped trusting', () => {
    const untrusted = user({ uncertain: true });

    expect(driftFindings([untrusted], [untrusted], cash('999.99'))).toEqual(
      skipped,
    );
  });

  it('skips a user that was never seeded', () => {
    const blind = user({ seeded: false });

    expect(driftFindings([blind], [blind], cash('999.99'))).toEqual(skipped);
  });

  it('skips a user that turned uncertain during the read', () => {
    expect(
      driftFindings([user()], [user({ uncertain: true })], cash('999.99')),
    ).toEqual(skipped);
  });

  it('skips a user with an order in flight', () => {
    const busy = user({ outstanding: 1 });

    expect(driftFindings([busy], [busy], cash('999.99'))).toEqual(skipped);
  });

  it('skips a user whose shadow moved while the API was being read', () => {
    expect(
      driftFindings([user()], [user({ cash: '900.00' })], cash('900.00')),
    ).toEqual(skipped);
  });

  it('skips a user the API could not be read for', () => {
    expect(driftFindings([user()], [user()], new Map())).toEqual(skipped);
  });

  it('reports every user that drifted and counts every user it held', () => {
    const two = [user(), user({ userId: 2, cash: '50.00' })];
    const { compared, findings } = driftFindings(
      two,
      two,
      new Map([
        [1, '1000.00'],
        [2, '60.00'],
      ]),
    );

    expect(compared).toBe(2);
    expect(findings.map((finding) => finding.context.userId)).toEqual([2]);
  });

  it('counts only the users it could hold, not the ones it was offered', () => {
    expect(
      driftFindings(
        [user(), user({ userId: 2, uncertain: true })],
        [user(), user({ userId: 2, uncertain: true })],
        new Map([
          [1, '1000.00'],
          [2, '50.00'],
        ]),
      ).compared,
    ).toBe(1);
  });
});
