import { MatchedOrder } from '../backoffice/anomaly';
import { Attempt } from '../store/attempts.store';
import { duplicateExecution } from './rules';

const AT = '2026-08-26T12:00:00.000Z';

const attempt = (over: Partial<Attempt> = {}): Attempt => ({
  id: 7,
  at: AT,
  method: 'POST',
  path: '/orders',
  latencyMs: 12,
  status: 0,
  ok: false,
  sent: { userId: 1, instrumentId: 47, side: 'BUY', size: 10, type: 'MARKET' },
  idempotencyKey: 'e4a1',
  chaos: { droppedStatus: 201, retriedBy: 8 },
  ...over,
});

const row = (over: Partial<MatchedOrder> = {}): MatchedOrder => ({
  id: 300,
  status: 'FILLED',
  at: AT,
  acknowledged: false,
  ...over,
});

describe('duplicate_execution', () => {
  it('calls two rows under one key critical', () => {
    const finding = duplicateExecution(attempt(), [
      row({ id: 300 }),
      row({ id: 301, acknowledged: true }),
    ]);

    expect(finding).toMatchObject({
      rule: 'duplicate_execution',
      severity: 'critical',
      context: {
        order: '1/47/BUY/10/MARKET',
        idempotencyKey: 'e4a1',
        retriedBy: 8,
        droppedStatus: 201,
      },
    });
    expect(finding?.message).toContain('2 rows for it, 2 of them FILLED');
  });

  // The key promises one order per user however the second one ended: a refused duplicate is
  // the same promise broken, with money left where it was by luck rather than by the rule.
  it('stays critical when only one of the rows moved money', () => {
    expect(
      duplicateExecution(attempt(), [
        row({ id: 300 }),
        row({ id: 301, status: 'REJECTED' }),
      ]),
    ).toMatchObject({ severity: 'critical' });
  });

  // Without a key the rows came from a shape-and-window match, which cannot tell one
  // client's order from another's: counting those as one order executed twice is the
  // false alarm this rule used to raise.
  it('says nothing about rows matched without a key', () => {
    expect(
      duplicateExecution(attempt({ idempotencyKey: undefined }), [
        row({ id: 300 }),
        row({ id: 301 }),
      ]),
    ).toBeUndefined();
  });

  it('counts every row the one order left behind', () => {
    const finding = duplicateExecution(attempt(), [
      row({ id: 300 }),
      row({ id: 301 }),
      row({ id: 302, status: 'REJECTED' }),
    ]);

    expect(finding?.message).toContain('3 rows for it, 2 of them FILLED');
  });

  // One row is one execution, which is the target behaving: the probe sent the order twice
  // and only one of the two ever reached a transaction.
  it('says nothing when the retry left no second row', () => {
    expect(duplicateExecution(attempt(), [row()])).toBeUndefined();
    expect(duplicateExecution(attempt(), [])).toBeUndefined();
  });

  // Two identically shaped orders from two clients are two orders. Only a send the probe
  // itself doubled can be claimed as one order the target executed twice.
  it('says nothing about rows nobody retried', () => {
    expect(
      duplicateExecution(attempt({ chaos: undefined }), [
        row(),
        row({ id: 301 }),
      ]),
    ).toBeUndefined();
    expect(
      duplicateExecution(attempt({ chaos: { droppedStatus: 201 } }), [
        row(),
        row({ id: 301 }),
      ]),
    ).toBeUndefined();
  });

  it('names the order it could not read rather than pretending it knows', () => {
    const finding = duplicateExecution(attempt({ sent: { userId: 1 } }), [
      row(),
      row({ id: 301 }),
    ]);

    expect(finding?.context.order).toBeUndefined();
    expect(finding?.message).toContain('unrecognised');
  });
});
