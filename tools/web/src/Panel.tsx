import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  CHAOS_MODES,
  clock,
  count,
  describe,
  money,
  send,
  stamp,
  usePoll,
  type Anomaly,
  type ChaosMode,
  type ChaosState,
  type LoadProfile,
  type LoadState,
  type RunResult,
  type SimulationState,
  type Severity,
  type Stats,
} from './api';
import Runs, { Invariants } from './Runs';
import { Num, Range, Stat, Tag, Toggle, type Tone } from './ui';

const USERS = [1, 2, 3, 4];
const FEED_ROWS = 40;
const PATCH_DEBOUNCE_MS = 250;

const SEVERITY_TONE: Record<Severity, Tone> = {
  critical: 'neg',
  warning: 'warn',
  info: 'info',
};

// Each mode reads its one knob in its own unit — that is what the label has to say.
const INTENSITY: Record<ChaosMode, { label: string; min: number; max: number; step: number }> = {
  latency_injection: { label: 'delay (ms)', min: 0, max: 5000, step: 50 },
  response_drop: { label: 'drop chance', min: 0, max: 1, step: 0.05 },
  client_retry: { label: 'retry chance', min: 0, max: 1, step: 0.05 },
  db_pause: { label: 'pause (s)', min: 1, max: 60, step: 1 },
};

type Knobs = {
  ratePerSec: number;
  buyRatio: number;
  sizeMin: number;
  sizeMax: number;
  latencyThresholdMs: number;
};

export default function Panel() {
  const sim = usePoll<SimulationState>('/simulation/state');
  const stats = usePoll<Stats>('/backoffice/stats');
  const anomalies = usePoll<Anomaly[]>('/backoffice/anomalies');
  const chaos = usePoll<ChaosState>('/chaos/state');
  const load = usePoll<LoadState>('/load/state');
  // `/load/state` drops `current` the moment a run ends, so the newest run is watched by id:
  // the same object, and it keeps its invariants on screen after the run is over.
  const held = load.data?.runs ?? [];
  const newest = held.length === 0 ? null : held[held.length - 1];
  const run = usePoll<RunResult>(newest === null ? null : `/load/runs/${newest}`);

  const [knobs, setKnobs] = useState<Knobs | null>(null);
  const [profile, setProfile] = useState<LoadProfile | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  // The panel is the only writer, so live values seed the forms and a touched form then
  // owns itself — a poll landing mid-drag must not snap a slider back.
  const live = knobs ?? seedKnobs(sim.data, stats.data);
  const plan = profile ?? load.data?.profile ?? null;

  useEffect(() => {
    if (knobs === null) {
      return;
    }
    const timer = window.setTimeout(() => {
      void send('PATCH', '/backoffice/config', knobs).catch((error: unknown) =>
        setFailure(describe(error)),
      );
    }, PATCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [knobs]);

  const act = async (name: string, call: () => Promise<unknown>): Promise<void> => {
    setBusy(name);
    setFailure(null);
    try {
      await call();
    } catch (error) {
      setFailure(describe(error));
    } finally {
      setBusy(null);
      sim.reload();
      load.reload();
      chaos.reload();
    }
  };

  const rows = anomalies.data ?? [];
  const rule = (name: string): number => rows.filter((row) => row.rule === name).length;
  // A disagreement needs both sides known — the same rule the unexpected_status detector
  // applies, so this tile and the feed beside it can never contradict each other. A row
  // whose actual is null is a placement the API never answered with an order, which load
  // shedding produces by the thousand: that is the shed count's story, not a disagreement.
  const disagreements = (stats.data?.outcomes ?? [])
    .filter(
      (row) => row.expected !== 'UNKNOWN' && row.actual !== null && row.expected !== row.actual,
    )
    .reduce((total, row) => total + row.count, 0);

  const running = sim.data?.config.running === true;
  const loadRunning = load.data?.running === true;
  const current = run.data ?? null;
  const gremlins = chaos.data;

  return (
    <div className="dark page">
      <div className="shell panel">
        <header className="top">
          <div className="brand">
            <span className={`dot${running || loadRunning ? ' on' : ''}`} aria-hidden="true" />
            <span>
              <b>Back office</b>
              <em>
                {running ? 'simulation running' : 'simulation stopped'}
                {loadRunning ? ' · load run in flight' : ''}
              </em>
            </span>
          </div>
          <span className="window num">
            {stats.data === undefined
              ? '—'
              : `${count(stats.data.window.attempts)} attempts in the recorder ring`}
          </span>
          <Link className="quiet-link" to="/">
            Trading
          </Link>
        </header>

        {failure !== null && <p className="banner">{failure}</p>}

        <section className="tiles">
          <h2 className="tiles-head">
            Simulation engine
            <em>counters since the sim process started, not this window</em>
          </h2>
          <div className="tile-row">
            <Stat label="Sent" value={count(sim.data?.counters.sent ?? 0)} />
            <Stat label="Filled" value={count(sim.data?.counters.filled ?? 0)} tone="pos" />
            <Stat label="Rejected" value={count(sim.data?.counters.rejected ?? 0)} tone="neg" />
            <Stat label="Failed" value={count(sim.data?.counters.failed ?? 0)} tone="warn" />
          </div>
          <h2 className="tiles-head">
            Recorder
            <em>
              {stats.data?.window.from == null
                ? 'no calls recorded yet'
                : `${stamp(stats.data.window.from)} → ${stamp(stats.data.window.to ?? stats.data.window.from)}`}
            </em>
          </h2>
          <div className="tile-row">
            <Stat
              label="Disagreements"
              value={count(disagreements)}
              hint="expected outcome ≠ actual"
              tone={disagreements > 0 ? 'neg' : undefined}
            />
            <Stat
              label="Lost orders"
              value={count(rule('lost_order'))}
              hint="sent, never answered"
              tone={rule('lost_order') > 0 ? 'warn' : undefined}
            />
            <Stat
              label="Duplicates"
              value={count(rule('duplicate_execution'))}
              hint="one order executed twice"
              tone={rule('duplicate_execution') > 0 ? 'neg' : undefined}
            />
            <Stat
              label="p95 latency"
              value={`${count(stats.data?.latencyMs.p95 ?? 0)} ms`}
              hint={`${count(stats.data?.latencyMs.samples ?? 0)} samples · ${count(stats.data?.shedding ?? 0)} shed`}
            />
          </div>
        </section>

        <div className="grid">
          <section className="col-main">
            <div className="card">
              <h2>Simulation</h2>
              <div className="actions">
                <button
                  type="button"
                  className="cta"
                  disabled={busy !== null || running}
                  onClick={() => void act('start', () => send('POST', '/simulation/start', {}))}
                >
                  {busy === 'start' ? 'Starting…' : 'Start'}
                </button>
                <button
                  type="button"
                  className="ghost"
                  disabled={busy !== null || !running}
                  onClick={() => void act('stop', () => send('POST', '/simulation/stop'))}
                >
                  Stop
                </button>
                <button
                  type="button"
                  className="ghost danger"
                  disabled={busy !== null}
                  onClick={() => {
                    if (window.confirm('Reseed the shadow ledger from the live API?')) {
                      void act('reset', () => send('POST', '/simulation/reset'));
                    }
                  }}
                >
                  Reset shadow
                </button>
              </div>
              {live !== null && (
                <>
                  <Range
                    label="Orders per second"
                    value={live.ratePerSec}
                    min={0.1}
                    max={50}
                    step={0.1}
                    display={live.ratePerSec.toFixed(1)}
                    onChange={(ratePerSec) => setKnobs({ ...live, ratePerSec })}
                  />
                  <Range
                    label="Buy ratio"
                    value={live.buyRatio}
                    min={0}
                    max={1}
                    step={0.05}
                    display={`${Math.round(live.buyRatio * 100)}% buy`}
                    onChange={(buyRatio) => setKnobs({ ...live, buyRatio })}
                  />
                  <Range
                    label="Smallest order"
                    value={live.sizeMin}
                    min={1}
                    max={100}
                    step={1}
                    display={`${live.sizeMin} shares`}
                    onChange={(sizeMin) =>
                      setKnobs({ ...live, sizeMin, sizeMax: Math.max(sizeMin, live.sizeMax) })
                    }
                  />
                  <Range
                    label="Largest order"
                    value={live.sizeMax}
                    min={1}
                    max={100}
                    step={1}
                    display={`${live.sizeMax} shares`}
                    onChange={(sizeMax) =>
                      setKnobs({ ...live, sizeMax, sizeMin: Math.min(sizeMax, live.sizeMin) })
                    }
                  />
                  <Range
                    label="Latency alert threshold"
                    value={live.latencyThresholdMs}
                    min={50}
                    max={5000}
                    step={50}
                    display={`${count(live.latencyThresholdMs)} ms`}
                    onChange={(latencyThresholdMs) => setKnobs({ ...live, latencyThresholdMs })}
                  />
                </>
              )}
              {sim.data !== undefined && (
                <ul className="shadow">
                  {sim.data.shadow.users.map((user) => (
                    <li key={user.userId}>
                      <b>User {user.userId}</b>
                      <span className={`num${user.cash.startsWith('-') ? ' t-neg' : ''}`}>
                        {money(user.cash)}
                      </span>
                      {!user.seeded && <Tag tone="warn">not seeded</Tag>}
                      {user.uncertain && <Tag tone="neg">uncertain</Tag>}
                      <span className="detail num">{user.outstanding} in flight</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="card">
              <h2>Load run</h2>
              {plan !== null && (
                <>
                  <div className="segmented">
                    {(['burst', 'ramp', 'contention'] as const).map((mode) => (
                      <button
                        key={mode}
                        type="button"
                        className={`seg${plan.mode === mode ? ' on' : ''}`}
                        aria-pressed={plan.mode === mode}
                        onClick={() => setProfile({ ...plan, mode })}
                      >
                        {mode}
                      </button>
                    ))}
                  </div>
                  <div className="nums">
                    <Num
                      label="Concurrency"
                      value={plan.concurrency}
                      min={1}
                      max={3000}
                      step={1}
                      onChange={(concurrency) => setProfile({ ...plan, concurrency })}
                    />
                    <Num
                      label="Total orders"
                      value={plan.totalOrders}
                      min={1}
                      max={5000}
                      step={1}
                      onChange={(totalOrders) => setProfile({ ...plan, totalOrders })}
                    />
                    <Num
                      label="Cancel mix"
                      value={plan.cancelMix}
                      min={0}
                      max={0.5}
                      step={0.05}
                      onChange={(cancelMix) => setProfile({ ...plan, cancelMix })}
                    />
                  </div>
                  <div className="users" role="group" aria-label="Users in the run">
                    {USERS.map((id) => {
                      const on = plan.users.includes(id);
                      return (
                        <button
                          key={id}
                          type="button"
                          className={`pill${on ? ' on' : ''}`}
                          aria-pressed={on}
                          onClick={() => {
                            const users = on
                              ? plan.users.filter((other) => other !== id)
                              : [...plan.users, id].sort((a, b) => a - b);
                            setProfile({ ...plan, users: users.length === 0 ? plan.users : users });
                          }}
                        >
                          User {id}
                        </button>
                      );
                    })}
                  </div>
                  <Toggle
                    label="All orders on one instrument"
                    on={plan.sameInstrument}
                    onChange={(sameInstrument) => setProfile({ ...plan, sameInstrument })}
                  />
                  <button
                    type="button"
                    className="cta"
                    disabled={busy !== null || loadRunning}
                    onClick={() => void act('load', () => send('POST', '/load/run', plan))}
                  >
                    {loadRunning ? 'Run in flight…' : 'Launch run'}
                  </button>
                </>
              )}

              {current !== null && (
                <div className="run-live">
                  <div className="run-live-head">
                    <span className="run-id num">{current.runId}</span>
                    <Tag tone={current.phase === 'done' ? 'pos' : current.phase === 'failed' ? 'neg' : 'info'}>
                      {current.phase}
                    </Tag>
                  </div>
                  <p className="detail num">
                    {count(current.sent)}/{count(current.profile.totalOrders)} sent ·{' '}
                    {count(current.shedding)} shed · {count(current.unanswered)} unanswered ·{' '}
                    cancels {count(current.cancels.cancelled)}/{count(current.cancels.requested)} (
                    {count(current.cancels.conflicted)} conflicted) · p95{' '}
                    {count(current.latencyMs.p95)} ms
                  </p>
                  {current.quiesce !== null && (
                    <p className="detail num">
                      quiesced in {count(current.quiesce.waitedMs)} ms
                      {current.quiesce.timedOut ? ' — TIMED OUT, orders were still in flight' : ''}
                    </p>
                  )}
                  {current.invariants.length > 0 && <Invariants invariants={current.invariants} />}
                  {current.error !== null && <p className="inline-error">{current.error}</p>}
                </div>
              )}
            </div>

            <div className="card">
              <h2>Chaos</h2>
              {gremlins !== undefined && (
                <>
                  {CHAOS_MODES.map((mode) => {
                    const toggle = gremlins.modes[mode];
                    const knob = INTENSITY[mode];
                    return (
                      <div className="chaos" key={mode}>
                        <Toggle
                          label={mode}
                          on={toggle.enabled}
                          onChange={(enabled) =>
                            void act(mode, () => send('POST', '/chaos/config', { mode, enabled }))
                          }
                        />
                        <Num
                          label={knob.label}
                          value={toggle.intensity}
                          min={knob.min}
                          max={knob.max}
                          step={knob.step}
                          onChange={(intensity) =>
                            void act(mode, () => send('POST', '/chaos/config', { mode, intensity }))
                          }
                        />
                      </div>
                    );
                  })}
                  <p className="detail num">
                    delays {count(gremlins.counters.delays)} · drops {count(gremlins.counters.drops)}{' '}
                    · retries {count(gremlins.counters.retries)} · pauses{' '}
                    {count(gremlins.counters.pauses)}
                  </p>
                  {gremlins.dbPausedUntil !== null && (
                    <p className="inline-error">
                      Database paused until {stamp(gremlins.dbPausedUntil)}
                    </p>
                  )}
                  {gremlins.lastError !== null && <p className="inline-error">{gremlins.lastError}</p>}
                </>
              )}
            </div>
          </section>

          <section className="col-side">
            <div className="card">
              <h2>
                Anomalies
                <span className="badge num">{count(rows.length)}</span>
              </h2>
              {anomalies.error !== null && <p className="inline-error">{anomalies.error}</p>}
              {rows.length === 0 && <p className="empty">Nothing flagged. The rules are running.</p>}
              <ul className="anomalies">
                {rows.slice(0, FEED_ROWS).map((row) => (
                  <Row key={row.id} anomaly={row} />
                ))}
              </ul>
              {rows.length > FEED_ROWS && (
                <p className="detail">
                  Showing the newest {FEED_ROWS} of {count(rows.length)} held.
                </p>
              )}
            </div>
          </section>
        </div>

        <Runs
          simRunning={running}
          loadRunning={loadRunning}
          threshold={stats.data?.config.latencyThresholdMs ?? 500}
        />
      </div>
    </div>
  );
}

function Row({ anomaly }: { anomaly: Anomaly }) {
  const [open, setOpen] = useState(false);
  // Chaos attribution is the context the detectors stamp on a finding, not a rule of its own:
  // these are the modes that were switched on when the call this finding is about was made.
  const active = Array.isArray(anomaly.context.chaosActive)
    ? (anomaly.context.chaosActive as string[])
    : [];

  return (
    <li className="anomaly">
      <button type="button" className="anomaly-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Tag tone={SEVERITY_TONE[anomaly.severity]}>{anomaly.severity}</Tag>
        <b>{anomaly.rule}</b>
        <span className="anomaly-time num">{clock(anomaly.at)}</span>
      </button>
      <p className="anomaly-message">{anomaly.message}</p>
      {active.length > 0 && (
        <p className="chaos-badges">
          {active.map((mode) => (
            <Tag key={mode} tone="warn">
              chaos: {mode}
            </Tag>
          ))}
        </p>
      )}
      {open && <pre className="context">{JSON.stringify(anomaly.context, null, 2)}</pre>}
    </li>
  );
}

const seedKnobs = (sim?: SimulationState, stats?: Stats): Knobs | null =>
  sim === undefined || stats === undefined
    ? null
    : {
        ratePerSec: sim.config.ratePerSec,
        buyRatio: sim.config.buyRatio,
        sizeMin: sim.config.sizeMin,
        sizeMax: sim.config.sizeMax,
        latencyThresholdMs: stats.config.latencyThresholdMs,
      };
