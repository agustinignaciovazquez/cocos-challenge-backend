import type { ReactNode } from 'react';

export type Tone = 'pos' | 'neg' | 'warn' | 'info' | 'mute';

export function Tag({
  tone = 'mute',
  children,
}: {
  tone?: Tone;
  children: ReactNode;
}) {
  return <span className={`tag tag-${tone}`}>{children}</span>;
}

export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="stat">
      <span className="stat-label">{label}</span>
      <strong className={`stat-value${tone === undefined ? '' : ` t-${tone}`}`}>{value}</strong>
      {hint !== undefined && <span className="stat-hint">{hint}</span>}
    </div>
  );
}

export function Range({
  label,
  value,
  min,
  max,
  step,
  display,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="range">
      <span className="range-head">
        {label}
        <b>{display}</b>
      </span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function Num({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="num">
      <span>{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </label>
  );
}

export function Toggle({
  label,
  on,
  onChange,
}: {
  label: string;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <label className="toggle">
      <input type="checkbox" checked={on} onChange={(event) => onChange(event.target.checked)} />
      <span className="track" aria-hidden="true" />
      <span className="toggle-label">{label}</span>
    </label>
  );
}
