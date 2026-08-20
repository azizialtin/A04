import type { NoteSnapshot, ReplayPoint } from '../api/participant'

/** Largest index i with points[i].t <= t, or -1. Points are sorted by t. */
export function lowerBound(points: ReplayPoint[], t: number): number {
  let lo = 0
  let hi = points.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (points[mid].t <= t) {
      ans = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  return ans
}

/**
 * Interpolated gaze position at video time `tMs`, or null when the nearest
 * sample is more than `maxGapMs` away (a blink/track-loss gap or a paused
 * stretch with no mapped samples).
 */
export function gazeAt(
  points: ReplayPoint[],
  tMs: number,
  maxGapMs = 200,
): { x: number; y: number } | null {
  if (points.length === 0) return null
  const i = lowerBound(points, tMs)
  const lo = i >= 0 ? points[i] : null
  const hi = i + 1 < points.length ? points[i + 1] : null

  if (lo && hi && hi.t - lo.t <= maxGapMs) {
    const frac = hi.t > lo.t ? (tMs - lo.t) / (hi.t - lo.t) : 0
    return { x: lo.x + (hi.x - lo.x) * frac, y: lo.y + (hi.y - lo.y) * frac }
  }
  if (lo && tMs - lo.t <= maxGapMs) return { x: lo.x, y: lo.y }
  if (hi && hi.t - tMs <= maxGapMs) return { x: hi.x, y: hi.y }
  return null
}

/** The notes as they stood at `videoTimeSeconds`: the latest snapshot at or
 * before that time. Assumes `notes` is sorted ascending by video time. */
export function noteAt(notes: NoteSnapshot[], videoTimeSeconds: number): string {
  let text = ''
  for (const n of notes) {
    if (n.video_time_seconds <= videoTimeSeconds) text = n.text
    else break
  }
  return text
}

export interface TimedText {
  t: number // ms into whatever is being played
  text: string
}

/**
 * The notes placed on a screen recording's timeline.
 *
 * A note's playhead position says where it belongs in the *clip*, which is no
 * help here: the recording runs on wall time and covers the pauses too. The
 * note's own `client_ts` is on that same clock, so the placement is the same
 * subtraction the gaze samples get. Notes written before `client_ts` existed
 * have nowhere to go and are dropped rather than guessed at.
 */
export function notesOnRecording(notes: NoteSnapshot[], epochMs: number): TimedText[] {
  return notes
    .filter((n): n is NoteSnapshot & { client_ts: number } => typeof n.client_ts === 'number')
    .map((n) => ({ t: n.client_ts - epochMs, text: n.text }))
    .sort((a, b) => a.t - b.t)
}

/** The same notes on the clip's own timeline, for the fallback replay. */
export function notesOnClip(notes: NoteSnapshot[]): TimedText[] {
  return notes.map((n) => ({ t: n.video_time_seconds * 1000, text: n.text }))
}

/** The latest entry at or before `tMs`. Assumes `items` is sorted by `t`. */
export function textAt(items: TimedText[], tMs: number): string {
  let text = ''
  for (const item of items) {
    if (item.t <= tMs) text = item.text
    else break
  }
  return text
}
