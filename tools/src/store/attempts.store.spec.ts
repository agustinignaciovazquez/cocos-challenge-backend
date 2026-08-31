import { AttemptsStore, ATTEMPTS_CAPACITY } from './attempts.store';

const attempt = (path: string) => ({
  at: '2026-08-26T12:00:00.000Z',
  method: 'GET',
  path,
  latencyMs: 7,
  status: 200,
  ok: true,
});

describe('AttemptsStore', () => {
  it('hands out ids from 1 and keeps them monotonic', () => {
    const store = new AttemptsStore();

    expect(store.record(attempt('/health'))).toBe(1);
    expect(store.record(attempt('/health'))).toBe(2);
    expect(store.size()).toBe(2);
  });

  it('returns the newest attempts first, capped at the requested limit', () => {
    const store = new AttemptsStore();
    store.record(attempt('/a'));
    store.record(attempt('/b'));
    store.record(attempt('/c'));

    expect(store.recent(2).map((row) => row.path)).toEqual(['/c', '/b']);
    expect(store.recent(10)).toHaveLength(3);
  });

  it('returns nothing while it is empty', () => {
    expect(new AttemptsStore().recent(10)).toEqual([]);
  });

  it('wraps at capacity, keeping the newest attempts and dropping the oldest', () => {
    const store = new AttemptsStore();
    const overflow = 3;
    for (let n = 1; n <= ATTEMPTS_CAPACITY + overflow; n++) {
      store.record(attempt(`/${n}`));
    }

    expect(store.size()).toBe(ATTEMPTS_CAPACITY);

    const newest = store.recent(ATTEMPTS_CAPACITY);
    expect(newest[0]).toMatchObject({
      id: ATTEMPTS_CAPACITY + overflow,
      path: `/${ATTEMPTS_CAPACITY + overflow}`,
    });
    expect(newest[ATTEMPTS_CAPACITY - 1]).toMatchObject({
      id: overflow + 1,
      path: `/${overflow + 1}`,
    });
  });

  it('annotates the attempt it is given', () => {
    const store = new AttemptsStore();
    const id = store.record(attempt('/orders'));

    store.annotate(id, { expected: 'FILLED', actual: 'REJECTED', orderId: 12 });

    expect(store.recent(1)[0]).toMatchObject({
      expected: 'FILLED',
      actual: 'REJECTED',
      orderId: 12,
    });
  });

  it('ignores an annotation for an attempt the ring has already dropped', () => {
    const store = new AttemptsStore();
    for (let n = 1; n <= ATTEMPTS_CAPACITY + 1; n++) {
      store.record(attempt(`/${n}`));
    }

    store.annotate(1, { expected: 'FILLED' });

    expect(store.recent(ATTEMPTS_CAPACITY).some((row) => row.id === 1)).toBe(
      false,
    );
    expect(
      store
        .recent(ATTEMPTS_CAPACITY)
        .filter((row) => row.expected !== undefined),
    ).toEqual([]);
  });
});
