import type { ReactNode } from 'react'

import { num, percent } from '../../lib/adminFormat'

/**
 * The pieces every statistics view is built from.
 *
 * Deliberately small: tiles, meters and one-hue bars, no chart library. Almost
 * everything a researcher asks of this dashboard is "how many" and "how far
 * along", and a labelled number answers that better than a plot of four
 * points. Where a shape does help — the day-by-day activity — it is a
 * single-hue bar row, so magnitude is the only thing colour ever says. State
 * (a failed capture, an inactive study) is the one exception, and it always
 * carries a mark beside the colour.
 */

/** A headline number with its label, and the context that makes it mean something. */
export function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string
  value: ReactNode
  hint?: ReactNode
  tone?: 'default' | 'warn' | 'bad'
}) {
  return (
    <div className={`stat${tone && tone !== 'default' ? ` stat--${tone}` : ''}`}>
      <span className="stat__label">{label}</span>
      <span className="stat__value">{value}</span>
      {hint != null && <span className="stat__hint">{hint}</span>}
    </div>
  )
}

export function StatGrid({ children }: { children: ReactNode }) {
  return <div className="stat-grid">{children}</div>
}

/**
 * A ratio against its limit. The track is a lighter step of the fill's own
 * hue, so a nearly-empty bar still reads as the same measure.
 */
export function Meter({
  value,
  label,
  tone = 'default',
}: {
  value: number | null
  label?: string
  tone?: 'default' | 'warn' | 'bad'
}) {
  const clamped = Math.max(0, Math.min(100, value ?? 0))
  return (
    <div className="meter" title={label ?? percent(value)}>
      <div
        className={`meter__fill${tone !== 'default' ? ` meter__fill--${tone}` : ''}`}
        style={{ width: `${clamped}%` }}
      />
      <span className="meter__text">{label ?? percent(value)}</span>
    </div>
  )
}

/**
 * A row of single-hue bars: one per item, height by magnitude. For the shapes
 * a column of numbers hides — a day everyone ran, a case nobody reached.
 */
export function BarRow({
  items,
  format = (v) => num(v),
}: {
  items: { key: string; label: string; value: number }[]
  format?: (value: number) => string
}) {
  const peak = Math.max(1, ...items.map((i) => i.value))
  if (!items.length) return <p className="muted">Noch keine Daten.</p>
  return (
    <div
      className="bars"
      role="img"
      aria-label={items.map((i) => `${i.label}: ${format(i.value)}`).join(', ')}
    >
      {items.map((item) => (
        <div key={item.key} className="bars__col" title={`${item.label}: ${format(item.value)}`}>
          <div className="bars__bar" style={{ height: `${(item.value / peak) * 100}%` }} />
          <span className="bars__tick">{item.label}</span>
        </div>
      ))}
    </div>
  )
}

/** Label/value pairs for the facts that belong together but are not headlines. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="facts">
      {rows.map(([label, value]) => (
        <div key={label} className="facts__row">
          <dt>{label}</dt>
          <dd>{value}</dd>
        </div>
      ))}
    </dl>
  )
}

/** A short state word, carrying a mark so colour is never the only cue. */
export function Pill({
  tone,
  children,
}: {
  tone: 'ok' | 'warn' | 'bad' | 'idle'
  children: ReactNode
}) {
  const mark = { ok: '✓', warn: '!', bad: '×', idle: '·' }[tone]
  return (
    <span className={`pill pill--${tone}`}>
      <span aria-hidden="true">{mark}</span>
      {children}
    </span>
  )
}
