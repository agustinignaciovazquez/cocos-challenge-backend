import { plainToInstance } from 'class-transformer';
import { GatewayResult, GatewayService } from '../gateway/gateway.service';
import { HistoryService } from '../history/history.service';
import { AttemptsStore } from '../store/attempts.store';
import { SimulationService } from './simulation.service';
import { StartSimulationDto } from './start-simulation.dto';

type Answer = (path: string) => GatewayResult;

// What the simulation asks of the run history: a window opens on start and closes on stop.
type Windows = {
  opened: string[];
  closed: { runId: string; sent: number }[];
};

const historyStub = (windows: Windows): HistoryService =>
  ({
    open: (mode: string): string => {
      windows.opened.push(mode);
      return `run-${windows.opened.length}`;
    },
    close: (runId: string, summary: { counters: { sent: number } }): void => {
      windows.closed.push({ runId, sent: summary.counters.sent });
    },
  }) as unknown as HistoryService;

const answered: Answer = (path) => ({
  attemptId: 1,
  status: 200,
  ok: true,
  body: path.endsWith('/portfolio')
    ? { availableCash: '1000.00', positions: [] }
    : { id: 1, status: 'FILLED', price: '100.00', size: 1 },
});

const unreachable: Answer = () => ({
  attemptId: 1,
  status: 0,
  ok: false,
  body: { message: 'fetch failed' },
});

const build = (
  answer: Answer = answered,
  windows: Windows = { opened: [], closed: [] },
): SimulationService =>
  new SimulationService(
    {
      send: (_method: string, path: string): Promise<GatewayResult> =>
        Promise.resolve(answer(path)),
    } as unknown as GatewayService,
    new AttemptsStore(),
    historyStub(windows),
  );

// The pipe hands the controller a DTO instance, and a DTO declares every optional knob
// as an own property — so the ones the caller omitted arrive as undefined.
const sent = (overrides: Record<string, unknown>): StartSimulationDto =>
  plainToInstance(StartSimulationDto, overrides);

describe('SimulationService', () => {
  it('starts with the documented defaults', () => {
    expect(build().state().config).toEqual({
      ratePerSec: 1,
      users: [1, 2, 3, 4],
      buyRatio: 0.6,
      sizeMin: 1,
      sizeMax: 50,
      running: false,
    });
  });

  it('keeps every knob the caller did not override', async () => {
    const service = build();

    await service.start(sent({ ratePerSec: 2 }));
    const { config } = service.stop();

    expect(config).toEqual({
      ratePerSec: 2,
      users: [1, 2, 3, 4],
      buyRatio: 0.6,
      sizeMin: 1,
      sizeMax: 50,
      running: false,
    });
  });

  it('seeds the shadow from each configured user before it starts ticking', async () => {
    const service = build();

    const { shadow } = await service.start(sent({ users: [1, 2] }));
    service.stop();

    expect(shadow.users).toEqual([
      {
        userId: 1,
        cash: '1000.00',
        seeded: true,
        uncertain: false,
        outstanding: 0,
        positions: [],
      },
      {
        userId: 2,
        cash: '1000.00',
        seeded: true,
        uncertain: false,
        outstanding: 0,
        positions: [],
      },
    ]);
  });

  it('refuses to run at all when no portfolio can be read', async () => {
    const service = build(unreachable);

    await expect(service.start(sent({ users: [1, 2] }))).rejects.toThrow(
      'no portfolio could be read for any of users 1, 2',
    );
    expect(service.state().config.running).toBe(false);
  });

  it('opens a run for the window it starts and closes it when it stops', async () => {
    const windows: Windows = { opened: [], closed: [] };
    const service = build(answered, windows);

    await service.start(sent({}));
    expect(windows.opened).toEqual(['sim']);
    expect(windows.closed).toEqual([]);

    service.stop();
    expect(windows.closed.map(({ runId }) => runId)).toEqual(['run-1']);
  });

  it('closes the window a second start replaces, and the one it could not seed', async () => {
    const windows: Windows = { opened: [], closed: [] };
    const service = build(answered, windows);

    await service.start(sent({}));
    await service.start(sent({}));
    expect(windows.closed.map(({ runId }) => runId)).toEqual(['run-1']);

    service.stop();
    const blind = build(unreachable, windows);
    await expect(blind.start(sent({}))).rejects.toThrow();
    expect(windows.closed.map(({ runId }) => runId)).toEqual([
      'run-1',
      'run-2',
      'run-3',
    ]);
  });

  it('runs on the users it could seed and reports the one it could not', async () => {
    const service = build((path) =>
      path === '/users/2/portfolio' ? unreachable(path) : answered(path),
    );

    const { config, shadow } = await service.start(sent({ users: [1, 2] }));
    service.stop();

    expect(config.running).toBe(true);
    expect(
      shadow.users.map(({ userId, seeded }) => ({ userId, seeded })),
    ).toEqual([
      { userId: 1, seeded: true },
      { userId: 2, seeded: false },
    ]);
  });

  it('refuses a size range it cannot draw from', async () => {
    await expect(
      build().start(sent({ sizeMin: 9, sizeMax: 2 })),
    ).rejects.toThrow('sizeMin must not exceed sizeMax');
  });
});

describe('SimulationService.prepare', () => {
  it('gives a guest user a shadow without enrolling it in the loop', async () => {
    const service = build();
    await service.start(sent({ users: [1] }));

    await service.prepare([4]);
    const { config, shadow } = service.stop();

    // The load engine needs user 4's shadow for the length of its run. It must not still be
    // trading user 4 an hour later, and /simulation/state must not say that it is.
    expect(config.users).toEqual([1]);
    expect(
      shadow.users.map(({ userId, seeded }) => ({ userId, seeded })),
    ).toEqual([
      { userId: 1, seeded: true },
      { userId: 4, seeded: true },
    ]);
  });

  it('leaves the configured users seeded alongside the guest', async () => {
    const service = build();
    await service.start(sent({ users: [1, 2] }));

    await service.prepare([3]);
    service.stop();

    expect(service.state().shadow.users.map(({ userId }) => userId)).toEqual([
      1, 2, 3,
    ]);
  });

  it('drops the guest again the next time the configured users are seeded', async () => {
    const service = build();
    await service.start(sent({ users: [1] }));
    await service.prepare([4]);

    await service.reset();
    service.stop();

    expect(service.state().shadow.users.map(({ userId }) => userId)).toEqual([
      1,
    ]);
  });
});

describe('SimulationService counters', () => {
  it('does not count an order the loop did not send', async () => {
    const service = build();
    await service.start(sent({ users: [1] }));
    service.stop();
    const before = service.state().counters;

    await service.place({
      userId: 1,
      instrumentId: 47,
      side: 'BUY',
      size: 1,
      type: 'MARKET',
    });

    const after = service.state().counters;
    expect(after.sent).toBe(before.sent);
    expect(after.filled).toBe(before.filled);
    // The shadow still moved, which is the half that is shared on purpose.
    expect(service.state().shadow.users[0].cash).toBe('900.00');
  });

  it('counts what the loop itself sends', async () => {
    const service = build();
    await service.start(sent({ users: [1], ratePerSec: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const { counters } = service.stop();

    expect(counters.sent).toBeGreaterThan(0);
    expect(counters.filled).toBe(counters.sent);
  });

  // The lifetime tally is what the loop has done since the process started; a run's manifest
  // has to be countable against the rows in its own directory, which is a window's worth.
  it('closes a window with its own counters, not the lifetime tally', async () => {
    const windows: Windows = { opened: [], closed: [] };
    const service = build(answered, windows);

    await service.start(sent({ users: [1], ratePerSec: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const first = service.stop().counters.sent;

    await service.start(sent({ users: [1], ratePerSec: 50 }));
    await new Promise((resolve) => setTimeout(resolve, 80));
    const lifetime = service.stop().counters.sent;

    expect(first).toBeGreaterThan(0);
    expect(lifetime).toBeGreaterThan(first);
    expect(windows.closed.map(({ sent: inWindow }) => inWindow)).toEqual([
      first,
      lifetime - first,
    ]);
  });
});

describe('SimulationService.configure', () => {
  it('writes only the knobs it was given and leaves the rest alone', async () => {
    const service = build();

    const config = await service.configure(sent({ buyRatio: 0.25 }));

    expect(config).toEqual({
      ratePerSec: 1,
      users: [1, 2, 3, 4],
      buyRatio: 0.25,
      sizeMin: 1,
      sizeMax: 50,
      running: false,
    });
  });

  it('does not start or stop the loop', async () => {
    const service = build();

    expect((await service.configure(sent({ ratePerSec: 5 }))).running).toBe(
      false,
    );

    await service.start(sent({}));
    expect((await service.configure(sent({ ratePerSec: 5 }))).running).toBe(
      true,
    );
    service.stop();
  });

  it('seeds the shadow for a user the run did not have before', async () => {
    const service = build();
    await service.start(sent({ users: [1] }));

    await service.configure(sent({ users: [1, 2] }));
    service.stop();

    expect(
      service.state().shadow.users.map(({ userId, seeded }) => ({
        userId,
        seeded,
      })),
    ).toEqual([
      { userId: 1, seeded: true },
      { userId: 2, seeded: true },
    ]);
  });

  it('refuses a size range it cannot draw from', async () => {
    await expect(
      build().configure(sent({ sizeMin: 9, sizeMax: 2 })),
    ).rejects.toThrow('sizeMin must not exceed sizeMax');
  });

  it('hands back a copy, so the caller cannot reach in and change the run', async () => {
    const service = build();

    const config = await service.configure(sent({ ratePerSec: 3 }));
    config.ratePerSec = 99;

    expect(service.state().config.ratePerSec).toBe(3);
  });
});
