/**
 * How the admin statistics render numbers, times and the study's own
 * vocabulary. The admin surface is German throughout, so the labels are too.
 */

/** An absent number is not zero: nobody has produced that data yet. */
export const DASH = '—'

export function num(value: number | null | undefined, digits = 0): string {
  if (value == null) return DASH
  return value.toLocaleString('de-DE', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })
}

/** Big counts shortened, because a stat tile is read at a glance. */
export function compact(value: number | null | undefined): string {
  if (value == null) return DASH
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)} Mio.`
  if (Math.abs(value) >= 10_000) return `${Math.round(value / 1000)} Tsd.`
  return num(value)
}

export function percent(value: number | null | undefined): string {
  return value == null ? DASH : `${num(value, value % 1 === 0 ? 0 : 1)} %`
}

export function duration(seconds: number | null | undefined): string {
  if (seconds == null) return DASH
  const total = Math.round(seconds)
  if (total < 60) return `${total} s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}:${String(total % 60).padStart(2, '0')} min`
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`
}

export function minutes(value: number | null | undefined): string {
  return value == null ? DASH : `${num(value, 1)} min`
}

export function bytes(value: number | null | undefined): string {
  if (value == null) return DASH
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`
  if (value >= 1024 ** 2) return `${Math.round(value / 1024 ** 2)} MB`
  if (value >= 1024) return `${Math.round(value / 1024)} kB`
  return `${value} B`
}

export function when(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleString('de-DE') : DASH
}

export function day(value: string | null | undefined): string {
  return value ? new Date(value).toLocaleDateString('de-DE') : DASH
}

/** A day on the activity axis, short enough to sit under a bar. */
export function tick(value: string): string {
  return new Date(value).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' })
}

export function average(values: number[]): number | null {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null
}

const PHASES: Record<string, string> = {
  pre_test: 'Vortest',
  training: 'Training',
  post_test: 'Nachtest',
}

const PLACEMENTS: Record<string, string> = {
  pre_test: 'Vor der Studie',
  diagnosis: 'Diagnose',
  case_outro: 'Nach dem Fall',
}

const STATUSES: Record<string, string> = {
  registered: 'angelegt',
  active: 'läuft',
  completed: 'abgeschlossen',
}

/** The step kinds `session_script.build_steps` produces. */
const STEPS: Record<string, string> = {
  welcome: 'Begrüßung',
  questionnaire: 'Fragebogen',
  sosci: 'SoSci-Umfrage',
  calibration: 'Kalibrierung',
  phase_transition: 'Phasenwechsel',
  case_intro: 'Fall-Einleitung',
  case_video: 'Fallvideo',
  diagnosis: 'Diagnose',
  case_outro: 'Fragen nach dem Fall',
  think_aloud: 'Lautes Denken',
  thanks: 'Abschluss',
}

export const phaseLabel = (value: string) => PHASES[value] ?? value
export const placementLabel = (value: string) => PLACEMENTS[value] ?? value
export const statusLabel = (value: string) => STATUSES[value] ?? value
export const stepLabel = (value: string) => STEPS[value] ?? value
