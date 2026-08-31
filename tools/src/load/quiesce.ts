import { ShadowUserSnapshot } from '../simulation/shadow-ledger';
import { Quiesce } from './run';

// A run's own last response has already settled by the time its promise resolves, so what
// this waits out is everything else still in flight against the same users — the free-running
// simulation, or a placement whose answer is still coming. Reading a balance before then
// compares a target that may have applied an order against a shadow that has not, and
// re-seeding before then produces a shadow that is uncertain from birth.
export const outstandingFor = (
  users: ShadowUserSnapshot[],
  userIds: number[],
): { userId: number; outstanding: number }[] =>
  userIds.map((userId) => ({
    userId,
    outstanding: users.find((user) => user.userId === userId)?.outstanding ?? 0,
  }));

export const isStill = (outstanding: { outstanding: number }[]): boolean =>
  outstanding.every((user) => user.outstanding === 0);

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

// Bounded, because a hot user under sustained load may never reach zero: an unbounded wait
// would hang the run rather than report that it could not be stilled.
export const waitForQuiesce = async (
  read: () => ShadowUserSnapshot[],
  userIds: number[],
  budgetMs: number,
  pollMs: number,
): Promise<Quiesce> => {
  const startedAt = Date.now();

  for (;;) {
    const outstanding = outstandingFor(read(), userIds);
    if (isStill(outstanding)) {
      return { waitedMs: Date.now() - startedAt, timedOut: false, outstanding };
    }
    if (Date.now() - startedAt >= budgetMs) {
      return { waitedMs: Date.now() - startedAt, timedOut: true, outstanding };
    }
    await delay(pollMs);
  }
};
