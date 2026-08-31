import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { isStill, outstandingFor, waitForQuiesce } from './quiesce';

const user = (userId: number, outstanding: number): ShadowUserSnapshot => ({
  userId,
  cash: '100.00',
  seeded: true,
  uncertain: false,
  outstanding,
  positions: [],
});

describe('what is still in flight', () => {
  it('reports each user the run touched', () => {
    expect(outstandingFor([user(1, 3), user(2, 0)], [1, 2])).toEqual([
      { userId: 1, outstanding: 3 },
      { userId: 2, outstanding: 0 },
    ]);
  });

  it('treats a user the shadow does not hold as having nothing in flight', () => {
    expect(outstandingFor([], [9])).toEqual([{ userId: 9, outstanding: 0 }]);
  });

  it('is still only when every one of them is at zero', () => {
    expect(isStill([{ outstanding: 0 }, { outstanding: 0 }])).toBe(true);
    expect(isStill([{ outstanding: 0 }, { outstanding: 1 }])).toBe(false);
    expect(isStill([])).toBe(true);
  });
});

describe('waiting for the run to go quiet', () => {
  it('does not wait at all when nothing is in flight', async () => {
    const quiesce = await waitForQuiesce(() => [user(1, 0)], [1], 1_000, 10);
    expect(quiesce.timedOut).toBe(false);
    expect(quiesce.waitedMs).toBeLessThan(50);
  });

  it('polls until the last order settles', async () => {
    let left = 3;
    const quiesce = await waitForQuiesce(
      () => [user(1, left > 0 ? left-- : 0)],
      [1],
      1_000,
      5,
    );
    expect(quiesce.timedOut).toBe(false);
    expect(quiesce.outstanding).toEqual([{ userId: 1, outstanding: 0 }]);
  });

  // A hot user under sustained load may never reach zero, and a harness that hangs there
  // measures nothing at all.
  it('gives up on its budget and says what was still in flight', async () => {
    const quiesce = await waitForQuiesce(() => [user(1, 2)], [1], 60, 10);
    expect(quiesce.timedOut).toBe(true);
    expect(quiesce.waitedMs).toBeGreaterThanOrEqual(60);
    expect(quiesce.outstanding).toEqual([{ userId: 1, outstanding: 2 }]);
  });
});
