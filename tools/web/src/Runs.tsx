import { useState } from 'react';
import {
  count,
  money,
  stamp,
  usePoll,
  type Attempt,
  type Invariant,
  type RunManifest,
  type RunResult,
} from './api';
import { Tag } from './ui';

const W = 640;
const H = 140;
const PAD = 8;

// The trace holds the harness's own `chaos:` rows too; they are events, not calls that were
// answered, so the trend leaves them out and says so. Neither is a call that never came back:
// its latency is the gateway's patience running out, and the recorder's own percentiles
// already refuse it for that reason. Drawn, a drop or a pause window would be a run of flat
// give-up times at the top of the chart, burying the real latencies underneath and putting
// a peak on the caption that the p95 tile beside it never reports.
const isCall = (attempt: Attempt): boolean =>
  !attempt.path.startsWith('chaos:') && attempt.status !== 0;

function LatencyTrend({ threshold }: { threshold: number }) {
  const attempts = usePoll<Attempt[]>('/attempts?limit=100');
  const calls = (attempts.data ?? []).filter(isCall).reverse();
  if (calls.length < 2) {
    return <p className="empty">Not enough answered calls yet to draw a trend.</p>;
  }

  // The only place a money-shaped exactness question does not arise: this is a millisecond
  // count being turned into a pixel, where an approximation is the whole point. The scale is
  // the data's own peak so the shape stays readable; a threshold above that has no line to
  // draw, and the caption says as much rather than flattening the trend to fit it in.
  const peak = Math.max(...calls.map((call) => call.latencyMs), 1);
  const y = (value: number): number => H - PAD - (value / peak) * (H - 2 * PAD);
  const points = calls
    .map((call, index) => `${(index / (calls.length - 1)) * W},${y(call.latencyMs)}`)
    .join(' ');

  return (
    <figure className="trend">
      <figcaption>
        <span>Latency of the last {calls.length} answered calls</span>
        <span className="num">
          peak {count(peak)} ms · threshold {count(threshold)} ms
          {threshold > peak ? ' (above the range)' : ''}
        </span>
      </figcaption>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Latency of the last ${calls.length} answered calls, peaking at ${peak} milliseconds against a ${threshold} millisecond threshold`}
      >
        {threshold <= peak && (
          <line className="trend-threshold" x1="0" x2={W} y1={y(threshold)} y2={y(threshold)} />
        )}
        <polyline className="trend-line" points={points} vectorEffect="non-scaling-stroke" />
      </svg>
    </figure>
  );
}

export function Invariants({ invariants }: { invariants: Invariant[] }) {
  return (
    <ul className="invariants">
      {invariants.map((invariant) => (
        <li key={invariant.name}>
          <Tag tone={invariant.pass ? 'pos' : 'neg'}>{invariant.pass ? 'PASS' : 'FAIL'}</Tag>
          <b>{invariant.name}</b>
          {/* A leg the run could not check still reports pass — only the detail says so, so
              the detail is never optional here. */}
          <span className="detail">{invariant.detail}</span>
        </li>
      ))}
    </ul>
  );
}

const asRunResult = (summary: Record<string, unknown> | null): RunResult | null =>
  summary !== null && Array.isArray((summary as RunResult).invariants)
    ? (summary as RunResult)
    : null;

type SimSummary = {
  counters?: { sent: number; filled: number; rejected: number; failed: number };
  shadow?: { users?: { userId: number; cash: string; uncertain: boolean }[] };
};

function Manifest({ run, live }: { run: RunManifest; live: boolean }) {
  const [open, setOpen] = useState(false);
  const load = asRunResult(run.summary);
  const sim = load === null ? ((run.summary ?? {}) as SimSummary) : null;
  const chaosAtStart = Object.entries(run.chaos.atStart)
    .filter(([, toggle]) => toggle.enabled)
    .map(([mode]) => mode);

  return (
    <li className="run">
      <button type="button" className="run-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="run-id num">{run.runId}</span>
        <Tag tone={run.mode === 'sim' ? 'info' : 'mute'}>{run.mode}</Tag>
        {run.finishedAt === null ? (
          live ? (
            <Tag tone="info">OPEN — running now</Tag>
          ) : (
            <Tag tone="warn">NO CLOSE RECORDED — killed or crashed mid-run</Tag>
          )
        ) : (
          <span className="run-when num">{stamp(run.finishedAt)}</span>
        )}
        {load !== null && (
          <Tag tone={load.invariants.every((one) => one.pass) ? 'pos' : 'neg'}>
            {load.invariants.filter((one) => one.pass).length}/{load.invariants.length} invariants
          </Tag>
        )}
        <span className="caret" aria-hidden="true">
          {open ? '−' : '+'}
        </span>
      </button>

      {open && (
        <div className="run-body">
          <dl className="pairs">
            <div>
              <dt>Started</dt>
              <dd className="num">{stamp(run.startedAt)}</dd>
            </div>
            <div>
              <dt>Chaos at start</dt>
              <dd>{chaosAtStart.length === 0 ? 'none' : chaosAtStart.join(', ')}</dd>
            </div>
            {load !== null && (
              <>
                <div>
                  <dt>Profile</dt>
                  <dd className="num">
                    {load.profile.mode} · {load.profile.concurrency} concurrent ·{' '}
                    {load.profile.totalOrders} orders · cancelMix {load.profile.cancelMix}
                  </dd>
                </div>
                <div>
                  <dt>Sent · shed · unanswered</dt>
                  <dd className="num">
                    {count(load.sent)} · {count(load.shedding)} · {count(load.unanswered)}
                  </dd>
                </div>
                <div>
                  <dt>Latency p50 / p95 / max</dt>
                  <dd className="num">
                    {count(load.latencyMs.p50)} / {count(load.latencyMs.p95)} /{' '}
                    {count(load.latencyMs.max)} ms
                  </dd>
                </div>
                <div>
                  <dt>Outcomes</dt>
                  <dd className="num">
                    {Object.entries(load.outcomes)
                      .map(([status, n]) => `${status} ${n}`)
                      .join(' · ') || '—'}
                  </dd>
                </div>
              </>
            )}
            {sim?.counters !== undefined && (
              <div>
                <dt>Window counters</dt>
                <dd className="num">
                  sent {count(sim.counters.sent)} · filled {count(sim.counters.filled)} · rejected{' '}
                  {count(sim.counters.rejected)} · failed {count(sim.counters.failed)}
                </dd>
              </div>
            )}
            {sim?.shadow?.users !== undefined && (
              <div>
                <dt>Shadow cash at close</dt>
                <dd className="num">
                  {sim.shadow.users
                    .map(
                      (user) =>
                        `user ${user.userId} ${money(user.cash)}${user.uncertain ? ' (uncertain)' : ''}`,
                    )
                    .join(' · ')}
                </dd>
              </div>
            )}
          </dl>

          {run.summary === null && (
            <p className="empty">
              No summary on disk — this run never got to write one. Its attempts and anomalies
              files are still the evidence of what it saw.
            </p>
          )}
          {load !== null && <Invariants invariants={load.invariants} />}
          {load?.error != null && <p className="inline-error">{load.error}</p>}
        </div>
      )}
    </li>
  );
}

export default function Runs({
  simRunning,
  loadRunning,
  threshold,
}: {
  simRunning: boolean;
  loadRunning: boolean;
  threshold: number;
}) {
  const runs = usePoll<RunManifest[]>('/history/runs');
  const held = runs.data ?? [];

  // A manifest without an end stamp is a run that never closed — which is either a run open
  // right now or one that was killed. Only the engines can tell those apart: the open one is
  // the newest unclosed manifest of a family whose engine says it is running. The listing is
  // newest first, so the first match is that one.
  const unclosed = (family: (mode: string) => boolean): string | undefined =>
    held.find((run) => run.finishedAt === null && family(run.mode))?.runId;
  const open = [
    simRunning ? unclosed((mode) => mode === 'sim') : undefined,
    loadRunning ? unclosed((mode) => mode.startsWith('load')) : undefined,
  ];

  return (
    <section className="card wide">
      <h2>Runs</h2>
      <LatencyTrend threshold={threshold} />
      {runs.error !== null && <p className="inline-error">{runs.error}</p>}
      {held.length === 0 && (
        <p className="empty">Nothing on disk yet. Start the simulation or launch a load run.</p>
      )}
      <ul className="runs">
        {held.map((run) => (
          <Manifest key={run.runId} run={run} live={open.includes(run.runId)} />
        ))}
      </ul>
    </section>
  );
}
