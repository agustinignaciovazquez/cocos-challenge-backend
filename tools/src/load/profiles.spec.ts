import { TRADABLE_INSTRUMENTS } from '../simulation/simulation.service';
import { HOT_INSTRUMENT, Step, Wave, planWaves } from './profiles';
import { DEFAULT_PROFILE, LoadProfile } from './run';

const profile = (over: Partial<LoadProfile> = {}): LoadProfile => ({
  ...DEFAULT_PROFILE,
  ...over,
});

const steps = (waves: Wave[]): Step[] => waves.flat();

const placed = (step: Step) => (step.kind === 'place' ? step.order : undefined);

describe('burst', () => {
  it('fires full waves and a short last one', () => {
    const waves = planWaves(profile({ concurrency: 10, totalOrders: 25 }));
    expect(waves.map((wave) => wave.length)).toEqual([10, 10, 5]);
  });

  it('sends exactly the orders it was asked for', () => {
    for (const totalOrders of [1, 7, 100, 200]) {
      expect(steps(planWaves(profile({ totalOrders }))).length).toBe(
        totalOrders,
      );
    }
  });

  it('sends nothing but market orders, whatever the cancel mix says', () => {
    const all = steps(planWaves(profile({ cancelMix: 0.5, totalOrders: 20 })));
    expect(all.every((step) => placed(step)?.type === 'MARKET')).toBe(true);
  });

  it('spreads the load across every user it was given', () => {
    const all = steps(planWaves(profile({ users: [1, 2, 3], totalOrders: 6 })));
    expect(all.map((step) => placed(step)?.userId)).toEqual([1, 2, 3, 1, 2, 3]);
  });

  it('holds every order to one instrument when asked to', () => {
    const all = steps(planWaves(profile({ totalOrders: 20 })));
    expect(
      all.every((step) => placed(step)?.instrumentId === HOT_INSTRUMENT),
    ).toBe(true);
  });

  it('rotates the instruments when it is not', () => {
    const all = steps(
      planWaves(profile({ sameInstrument: false, totalOrders: 7 })),
    );
    expect(all.map((step) => placed(step)?.instrumentId)).toEqual(
      TRADABLE_INSTRUMENTS,
    );
  });

  it('alternates the side so a position is traded rather than only bought', () => {
    const all = steps(planWaves(profile({ totalOrders: 4 })));
    expect(all.map((step) => placed(step)?.side)).toEqual([
      'BUY',
      'SELL',
      'BUY',
      'SELL',
    ]);
  });
});

describe('ramp', () => {
  const ramp = profile({ mode: 'ramp', concurrency: 25, totalOrders: 200 });

  it('opens at one and reaches the configured concurrency', () => {
    const widths = planWaves(ramp).map((wave) => wave.length);
    expect(widths[0]).toBe(1);
    expect(Math.max(...widths)).toBe(25);
  });

  it('holds at the top rather than being cut short by the orders it has left', () => {
    const widths = planWaves(ramp).map((wave) => wave.length);
    expect(widths.filter((width) => width === 25).length).toBeGreaterThan(1);
  });

  it('never steps back down', () => {
    const widths = planWaves(ramp).map((wave) => wave.length);
    // The last wave is whatever is left over, so it is the only one allowed to be short.
    for (let at = 1; at < widths.length - 1; at++) {
      expect(widths[at]).toBeGreaterThanOrEqual(widths[at - 1]);
    }
  });

  it('still sends exactly the orders it was asked for', () => {
    expect(steps(planWaves(ramp)).length).toBe(200);
  });
});

describe('contention', () => {
  const hot = profile({
    mode: 'contention',
    users: [1, 2, 3],
    totalOrders: 20,
  });

  it('puts every order on one user however many it was given', () => {
    const all = steps(planWaves(hot));
    expect(all.every((step) => placed(step)?.userId !== 2)).toBe(true);
    expect(new Set(all.map((step) => placed(step)?.userId))).toEqual(
      new Set([1, undefined]),
    );
  });

  it('rests a limit order and cancels it one step later', () => {
    const all = steps(
      planWaves(profile({ mode: 'contention', totalOrders: 20 })),
    );
    expect(placed(all[0])?.type).toBe('LIMIT');
    expect(all[1].kind).toBe('cancel');
    expect(placed(all[10])?.type).toBe('LIMIT');
    expect(all[11].kind).toBe('cancel');
    expect(all.filter((step) => step.kind === 'cancel').length).toBe(2);
  });

  it('rests a buy, which is covered by any cash at all', () => {
    const first = placed(steps(planWaves(hot))[0]);
    expect(first).toEqual({
      userId: 1,
      instrumentId: HOT_INSTRUMENT,
      side: 'BUY',
      size: 1,
      type: 'LIMIT',
      price: '1.00',
    });
  });

  it('gives every cancel the resting order it would place instead', () => {
    const all = steps(planWaves(hot));
    const cancel = all.find((step) => step.kind === 'cancel');
    expect(cancel?.kind === 'cancel' && cancel.fallback.type).toBe('LIMIT');
  });

  it('sends nothing but market orders when the mix is zero', () => {
    const all = steps(
      planWaves(profile({ mode: 'contention', cancelMix: 0, totalOrders: 20 })),
    );
    expect(all.every((step) => placed(step)?.type === 'MARKET')).toBe(true);
  });

  it('alternates place and cancel at the highest mix it accepts', () => {
    const all = steps(
      planWaves(
        profile({ mode: 'contention', cancelMix: 0.5, totalOrders: 6 }),
      ),
    );
    expect(all.map((step) => step.kind)).toEqual([
      'place',
      'cancel',
      'place',
      'cancel',
      'place',
      'cancel',
    ]);
  });

  it('counts a cancel against the total like any other step', () => {
    expect(steps(planWaves(hot)).length).toBe(20);
  });
});
