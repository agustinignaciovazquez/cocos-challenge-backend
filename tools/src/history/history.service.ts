import {
  BadRequestException,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { WriteStream, createWriteStream, mkdirSync } from 'node:fs';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AnomaliesStore } from '../backoffice/anomalies.store';
import { ChaosService } from '../chaos/chaos.service';
import { AttemptsStore } from '../store/attempts.store';
import {
  Page,
  RUN_ID,
  RunCounts,
  RunManifest,
  pageOf,
  runIdFor,
} from './history';

type Trace = 'attempts' | 'anomalies';

type OpenRun = {
  manifest: RunManifest;
  dir: string;
  files: Record<Trace, WriteStream>;
};

@Injectable()
export class HistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly root =
    process.env.RUNS_DIR ?? resolve(process.cwd(), 'runs');
  private readonly running = new Map<string, OpenRun>();
  // A run whose disk gave way is reported once and then written off. Retrying a broken run
  // once per attempt would turn one full disk into thousands of anomalies.
  private readonly disowned = new Set<string>();

  constructor(
    private readonly attempts: AttemptsStore,
    private readonly anomalies: AnomaliesStore,
    private readonly chaos: ChaosService,
  ) {}

  onModuleInit(): void {
    this.attempts.tap((row) => this.append('attempts', row));
    this.anomalies.tap((row) => this.append('anomalies', row));
  }

  // A run still open when the harness is asked to stop is closed with what it had, so the one
  // shutdown the operator does on purpose does not look like the crash the files are for.
  async onModuleDestroy(): Promise<void> {
    await Promise.all(
      [...this.running.keys()].map((runId) => this.finish(runId)),
    );
  }

  open(mode: string, config: Record<string, unknown>): string {
    const at = new Date();
    const runId = runIdFor(mode, at);
    const dir = join(this.root, runId);
    const manifest: RunManifest = {
      runId,
      mode,
      startedAt: at.toISOString(),
      finishedAt: null,
      config,
      chaos: { atStart: this.chaos.state().modes, atEnd: null },
      summary: null,
    };

    try {
      // The one blocking call on this path, and it happens once a run rather than once a row:
      // the directory has to exist before the first attempt can be written into it.
      mkdirSync(dir, { recursive: true });
      const run: OpenRun = {
        manifest,
        dir,
        files: {
          attempts: this.stream(runId, dir, 'attempts'),
          anomalies: this.stream(runId, dir, 'anomalies'),
        },
      };
      this.running.set(runId, run);
      void this.writeManifest(run);
    } catch (error: unknown) {
      this.disown(runId, error);
    }
    return runId;
  }

  close(runId: string, summary?: Record<string, unknown>): void {
    // A turn later, behind the rows the recorder handed over before the run was told to stop:
    // both queue on the same timer, and a row from inside the window belongs inside the file.
    setImmediate(() => void this.finish(runId, summary));
  }

  async list(): Promise<RunManifest[]> {
    const entries = await readdir(this.root, { withFileTypes: true }).catch(
      () => [],
    );
    const manifests = await Promise.all(
      entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => this.manifest(entry.name).catch(() => null)),
    );
    return manifests
      .filter((manifest) => manifest !== null)
      .sort((a, b) => b.runId.localeCompare(a.runId));
  }

  async run(runId: string): Promise<RunManifest & { counts: RunCounts }> {
    const manifest = await this.manifest(runId);
    const [attempts, anomalies] = await Promise.all([
      this.count(runId, 'attempts'),
      this.count(runId, 'anomalies'),
    ]);
    return { ...manifest, counts: { attempts, anomalies } };
  }

  async rows(runId: string, offset: number, limit: number): Promise<Page> {
    const text = await this.read(runId, 'attempts');
    return { runId, offset, limit, ...pageOf(text, offset, limit) };
  }

  private async finish(
    runId: string,
    summary?: Record<string, unknown>,
  ): Promise<void> {
    const run = this.running.get(runId);
    if (run === undefined) {
      return;
    }
    this.running.delete(runId);
    run.manifest.finishedAt = new Date().toISOString();
    run.manifest.chaos.atEnd = this.chaos.state().modes;
    run.manifest.summary = summary ?? run.manifest.summary;
    for (const file of Object.values(run.files)) {
      file.end();
    }
    await this.writeManifest(run);
  }

  private async writeManifest(run: OpenRun): Promise<void> {
    await writeFile(
      join(run.dir, 'manifest.json'),
      `${JSON.stringify(run.manifest, null, 2)}\n`,
    ).catch((error: unknown) => this.disown(run.manifest.runId, error));
  }

  private stream(runId: string, dir: string, trace: Trace): WriteStream {
    const file = createWriteStream(join(dir, `${trace}.jsonl`), { flags: 'a' });
    file.on('error', (error) => this.disown(runId, error));
    return file;
  }

  private append(trace: Trace, row: unknown): void {
    // Every run open right now gets the row. A call made during a window is part of that
    // window's evidence, and leaving it out because a second run was also open would put the
    // hole back that these files exist to close.
    for (const [runId, run] of this.running) {
      try {
        run.files[trace].write(`${JSON.stringify(row)}\n`);
      } catch (error: unknown) {
        this.disown(runId, error);
      }
    }
  }

  // Dropped from the open runs before the anomaly is recorded: recording one writes a row into
  // every open run, and a run whose disk just failed must not be asked to take it.
  private disown(runId: string, error: unknown): void {
    if (this.disowned.has(runId)) {
      return;
    }
    this.disowned.add(runId);
    this.running.delete(runId);
    this.anomalies.record({
      rule: 'history_write_failed',
      severity: 'warning',
      message: `Run ${runId} is no longer being written to disk: ${error instanceof Error ? error.message : String(error)}`,
      context: { runId },
    });
  }

  private async manifest(runId: string): Promise<RunManifest> {
    return JSON.parse(
      await this.read(runId, 'manifest', 'json'),
    ) as RunManifest;
  }

  private async count(runId: string, trace: Trace): Promise<number> {
    const text = await this.read(runId, trace);
    return text.split('\n').filter((line) => line !== '').length;
  }

  private async read(
    runId: string,
    name: string,
    extension = 'jsonl',
  ): Promise<string> {
    if (!RUN_ID.test(runId)) {
      throw new BadRequestException(`${runId} is not a run id`);
    }
    return readFile(
      join(this.root, runId, `${name}.${extension}`),
      'utf8',
    ).catch(() => {
      throw new NotFoundException(`No ${name} was written for run ${runId}`);
    });
  }
}
