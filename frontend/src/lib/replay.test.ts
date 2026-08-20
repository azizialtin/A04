import type { NoteSnapshot, ReplayPoint } from '../api/participant'
import { gazeAt, lowerBound, noteAt, notesOnClip, notesOnRecording, textAt } from './replay'

const points: ReplayPoint[] = [
  { t: 0, x: 0, y: 0 },
  { t: 100, x: 0.2, y: 0.2 },
  { t: 200, x: 0.4, y: 0.4 },
]

test('lowerBound finds the last point at or before t', () => {
  expect(lowerBound(points, -5)).toBe(-1)
  expect(lowerBound(points, 100)).toBe(1)
  expect(lowerBound(points, 150)).toBe(1)
  expect(lowerBound(points, 999)).toBe(2)
})

test('gazeAt interpolates between two near samples', () => {
  const g = gazeAt(points, 150)
  expect(g).not.toBeNull()
  expect(g!.x).toBeCloseTo(0.3)
  expect(g!.y).toBeCloseTo(0.3)
})

test('gazeAt returns null across a gap larger than maxGapMs', () => {
  const sparse: ReplayPoint[] = [
    { t: 0, x: 0.1, y: 0.1 },
    { t: 5000, x: 0.9, y: 0.9 },
  ]
  expect(gazeAt(sparse, 2500)).toBeNull()
})

test('noteAt returns the latest snapshot at or before the time', () => {
  const notes: NoteSnapshot[] = [
    { video_time_seconds: 1, client_ts: null, text: 'first', created_at: 'a' },
    { video_time_seconds: 5, client_ts: null, text: 'first, second', created_at: 'b' },
  ]
  expect(noteAt(notes, 0)).toBe('')
  expect(noteAt(notes, 3)).toBe('first')
  expect(noteAt(notes, 10)).toBe('first, second')
})

const EPOCH = 1_700_000_000_000

test('notesOnRecording places notes by their own clock, not the playhead', () => {
  // Written 30 s into the recording but only 5 s into the clip — the
  // participant had the clip paused while they typed.
  const notes: NoteSnapshot[] = [
    { video_time_seconds: 5, client_ts: EPOCH + 30_000, text: 'paused to think', created_at: 'a' },
  ]
  expect(notesOnRecording(notes, EPOCH)).toEqual([{ t: 30_000, text: 'paused to think' }])
  expect(notesOnClip(notes)).toEqual([{ t: 5_000, text: 'paused to think' }])
})

test('notesOnRecording drops notes with no clock rather than guessing', () => {
  const notes: NoteSnapshot[] = [
    { video_time_seconds: 1, client_ts: null, text: 'from before client_ts', created_at: 'a' },
    { video_time_seconds: 2, client_ts: EPOCH + 1_000, text: 'placeable', created_at: 'b' },
  ]
  expect(notesOnRecording(notes, EPOCH)).toEqual([{ t: 1_000, text: 'placeable' }])
})

test('notesOnRecording sorts, since wall time and playhead order can differ', () => {
  const notes: NoteSnapshot[] = [
    { video_time_seconds: 9, client_ts: EPOCH + 2_000, text: 'second', created_at: 'a' },
    { video_time_seconds: 1, client_ts: EPOCH + 1_000, text: 'first', created_at: 'b' },
  ]
  expect(notesOnRecording(notes, EPOCH).map((n) => n.text)).toEqual(['first', 'second'])
})

test('textAt returns the latest entry at or before the time', () => {
  const timeline = [
    { t: 1_000, text: 'first' },
    { t: 5_000, text: 'first, second' },
  ]
  expect(textAt(timeline, 0)).toBe('')
  expect(textAt(timeline, 3_000)).toBe('first')
  expect(textAt(timeline, 10_000)).toBe('first, second')
})
