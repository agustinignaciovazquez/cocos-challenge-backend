import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AnomaliesStore } from '../backoffice/anomalies.store';
import { ChaosService } from '../chaos/chaos.service';
import { Attempt, AttemptsStore } from '../store/attempts.store';
import { RunManifest, pageOf } from './history';
import { HistoryService } from './history.service';

const attempt = (path = '/orders'): Omit<Attempt, 'id'> => ({
  at: new Date().toISOString(),
  method: 'POST',
  path,
  latencyMs: 4,
  status: 201,
  ok: true,
});

describe('pageOf', () => {
  const jsonl = (ids: number[]): string =>
    `${ids.map((id) => JSON.stringify({ id })).join('\n')}\n`;

  it('serves the page that straddles no boundary of its own', () => {
    expect(pageOf(jsonl([1, 2, 3, 4, 5]), 2, 2)).toEqual({
      total: 5,
      rows: [{ id: 3 }, { id: 4 }],
    });
  });

  it('runs out of rows without running out of total', () => {
    expect(pageOf(jsonl([1, 2, 3]), 2, 10)).toEqual({
      total: 3,
      rows: [{ id: 3 }],
    });
    expect(pageOf(jsonl([1, 2, 3]), 9, 10)).toEqual({ total: 3, rows: [] });
  });

  // What a killed run leaves behind: the write that was in flight is half a line.
  it('counts a torn last line but does not serve it', () => {
    expect(pageOf(`${jsonl([1, 2])}{"id":3`, 0, 10)).toEqual({
      total: 3,
      rows: [{ id: 1 }, { id: 2 }],
    });
  });
});

describe('HistoryService', () => {
  let root: string;
  let attempts: AttemptsStore;
  let anomalies: AnomaliesStore;
  let history: HistoryService;

  const build = (): HistoryService => {
    attempts = new AttemptsStore();
    anomalies = new AnomaliesStore(new ChaosService(attempts));
    process.env.RUNS_DIR = root;
    const service = new HistoryService(
      attempts,
      anomalies,
      new ChaosService(attempts),
    );
    service.onModuleInit();
    return service;
  };

  // Nothing on the recording path waits for the disk, so a test has to. The wait is bounded:
  // one that never sees what it is waiting for fails on the assertion rather than hanging.
  const until = async <T>(
    read: () => Promise<T>,
    ready: (value: T) => boolean,
  ): Promise<T> => {
    const limit = Date.now() + 2_000;
    for (;;) {
      const value = await read().catch(() => null);
      if ((value !== null && ready(value)) || Date.now() > limit) {
        return value as T;
      }
      await new Promise((done) => setTimeout(done, 5));
    }
  };

  const settled = (runId: string, rows: number): Promise<number> =>
    until(
      () => history.rows(runId, 0, 1_000).then(({ total }) => total),
      (total) => total >= rows,
    );

  const manifest = (runId: string, closed = false): Promise<RunManifest> =>
    until(
      () =>
        readFile(join(root, runId, 'manifest.json'), 'utf8').then(
          (text) => JSON.parse(text) as RunManifest,
        ),
      ({ finishedAt }) => (finishedAt !== null) === closed,
    );

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'cocos-runs-'));
    history = build();
  });

  afterEach(async () => {
    delete process.env.RUNS_DIR;
    await rm(root, { recursive: true, force: true });
  });

  it('names a run after the moment it opened and the mode it was opened for', () => {
    expect(history.open('sim', {})).toMatch(/^[\d-]+T[\d-]+Z-sim$/);
  });

  it('writes a manifest when the run opens and completes it when it closes', async () => {
    const runId = history.open('sim', { simulation: { ratePerSec: 2 } });
    expect(await manifest(runId)).toMatchObject({
      runId,
      mode: 'sim',
      finishedAt: null,
      config: { simulation: { ratePerSec: 2 } },
      summary: null,
    });

    history.close(runId, { counters: { sent: 3 } });
    const closed = await manifest(runId, true);

    expect(closed.finishedAt).not.toBeNull();
    expect(closed.summary).toEqual({ counters: { sent: 3 } });
    expect(closed.chaos.atEnd).toEqual(closed.chaos.atStart);
  });

  it('takes a copy of every attempt and every anomaly the run was open for', async () => {
    const runId = history.open('sim', {});
    attempts.record(attempt());
    anomalies.record({
      rule: 'late_response',
      severity: 'warning',
      message: 'slow',
      context: {},
    });
    await settled(runId, 1);

    expect((await history.run(runId)).counts).toEqual({
      attempts: 1,
      anomalies: 1,
    });
    expect((await history.rows(runId, 0, 10)).rows).toMatchObject([
      { id: 1, path: '/orders' },
    ]);
  });

  // The load engine and the simulation run at once by design, so a row belongs to the window
  // it happened in — to both windows when both were open.
  it('writes a row into every run that was open when it happened', async () => {
    const sim = history.open('sim', {});
    const load = history.open('load-burst', {});
    attempts.record(attempt());
    await Promise.all([settled(sim, 1), settled(load, 1)]);

    expect((await history.run(sim)).counts.attempts).toBe(1);
    expect((await history.run(load)).counts.attempts).toBe(1);
  });

  it('leaves the run alone once it has closed', async () => {
    const runId = history.open('sim', {});
    attempts.record(attempt('/orders/1'));
    history.close(runId, {});
    await settled(runId, 1);
    attempts.record(attempt('/orders/2'));
    await new Promise((done) => setImmediate(done));

    expect((await history.run(runId)).counts.attempts).toBe(1);
  });

  it('reports a run it cannot write once, and does not report it again', async () => {
    await rm(root, { recursive: true, force: true });
    await writeFile(root, 'not a directory');

    const runId = history.open('sim', {});
    for (let row = 0; row < 20; row++) {
      attempts.record(attempt());
    }
    await new Promise((done) => setTimeout(done, 20));

    const recorded = anomalies.recent(10);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({
      rule: 'history_write_failed',
      severity: 'warning',
      context: { runId },
    });
  });

  it('lists the runs newest first and refuses an id that is not one', async () => {
    const first = history.open('sim', {});
    const second = history.open('load-burst', {});
    history.close(second, {});
    history.close(first, {});
    await Promise.all([manifest(first, true), manifest(second, true)]);

    expect((await history.list()).map(({ runId }) => runId)).toEqual(
      [first, second].sort().reverse(),
    );
    await expect(history.run('../../etc')).rejects.toThrow();
    await expect(history.run('run-nobody-opened')).rejects.toThrow();
  });
});
