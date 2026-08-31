import { ChaosMode } from '../chaos/chaos';
import { CHAOS_WINDOW_MS, ChaosService } from '../chaos/chaos.service';
import { AttemptsStore } from '../store/attempts.store';
import { ANOMALIES_CAPACITY, AnomaliesStore } from './anomalies.store';
import { Finding } from './anomaly';

const finding = (message: string): Finding => ({
  rule: 'latency_high',
  severity: 'warning',
  message,
  context: {},
});

const newStore = (
  chaos = new ChaosService(new AttemptsStore()),
): AnomaliesStore => new AnomaliesStore(chaos);

describe('AnomaliesStore', () => {
  it('is empty before anything is found', () => {
    expect(newStore().recent(10)).toEqual([]);
  });

  it('stamps an id and a time onto what a detector found', () => {
    const anomaly = newStore().record(finding('slow'));

    expect(anomaly.id).toBe(1);
    expect(anomaly.message).toBe('slow');
    expect(Date.parse(anomaly.at)).not.toBeNaN();
  });

  it('hands back the newest first', () => {
    const store = newStore();
    store.record(finding('first'));
    store.record(finding('second'));
    store.record(finding('third'));

    expect(store.recent(2).map((anomaly) => anomaly.message)).toEqual([
      'third',
      'second',
    ]);
  });

  it('keeps the newest and drops the oldest at capacity', () => {
    const store = newStore();
    for (let n = 1; n <= ANOMALIES_CAPACITY + 3; n++) {
      store.record(finding(`n${n}`));
    }

    const newest = store.recent(ANOMALIES_CAPACITY + 10);

    expect(store.size()).toBe(ANOMALIES_CAPACITY);
    expect(newest).toHaveLength(ANOMALIES_CAPACITY);
    expect(newest[0].message).toBe(`n${ANOMALIES_CAPACITY + 3}`);
    expect(newest[ANOMALIES_CAPACITY - 1].message).toBe('n4');
  });

  it('empties on a clear and says how many it dropped', () => {
    const store = newStore();
    store.record(finding('first'));
    store.record(finding('second'));

    expect(store.clear()).toBe(2);
    expect(store.recent(10)).toEqual([]);
    expect(store.clear()).toBe(0);
  });

  // A client that has already seen anomaly 2 must never be handed a different anomaly 2.
  it('keeps counting ids across a clear', () => {
    const store = newStore();
    store.record(finding('first'));
    store.record(finding('second'));
    store.clear();

    expect(store.record(finding('third')).id).toBe(3);
  });
});

// A finding made while the harness was breaking things on purpose must say so, or a run of
// injected failures drowns the one real bug found beside them.
describe('chaos-window tagging', () => {
  const chaos = (...modes: ChaosMode[]): ChaosService => {
    const service = new ChaosService(new AttemptsStore());
    for (const mode of modes) {
      service.configure({ mode, enabled: true });
    }
    return service;
  };

  it('says out loud that nothing was being injected', () => {
    expect(newStore().record(finding('slow')).context).toEqual({
      chaosActive: [],
    });
  });

  it('names every mode that was active when the finding was made', () => {
    const store = newStore(chaos('response_drop', 'client_retry'));

    expect(store.record(finding('slow')).context.chaosActive).toEqual([
      'response_drop',
      'client_retry',
    ]);
  });

  // A finding is made up to a sweep behind the call it is about, and a lost order is
  // reconciled a quarter of a minute behind that, so the window has to outlive the mode.
  it('still names a mode that stopped a moment ago', () => {
    const service = chaos('response_drop');
    const store = newStore(service);
    service.configure({ mode: 'response_drop', enabled: false });

    expect(store.record(finding('just after')).context.chaosActive).toEqual([
      'response_drop',
    ]);
  });

  it('forgets it once the window has closed', () => {
    jest.useFakeTimers();
    try {
      const service = chaos('response_drop');
      const store = newStore(service);
      service.configure({ mode: 'response_drop', enabled: false });
      jest.advanceTimersByTime(CHAOS_WINDOW_MS + 1);

      expect(store.record(finding('long after')).context.chaosActive).toEqual(
        [],
      );
    } finally {
      jest.useRealTimers();
    }
  });

  // The rule's own context is the finding; the tag is the harness's note beside it and must
  // never be able to overwrite what a detector said.
  it('leaves the finding own context untouched', () => {
    const store = newStore(chaos('latency_injection'));
    const anomaly = store.record({
      ...finding('slow'),
      context: { latencyMs: 900 },
    });

    expect(anomaly.context).toEqual({
      chaosActive: ['latency_injection'],
      latencyMs: 900,
    });
  });
});
