import { expect, test } from 'vitest'

import { latestNote } from './notes'
import { notesOnClip, notesOnRecording } from './replay'

test('recap follows the writing clock while each replay follows its own timeline', () => {
  const notes = [
    { video_time_seconds: 12, client_ts: 1000, text: 'Earlier text', created_at: '' },
    {
      video_time_seconds: 0,
      client_ts: 2000,
      text: 'Final text after reload or seek',
      created_at: '',
    },
  ]
  expect(latestNote([...notes].reverse())?.text).toBe('Final text after reload or seek')
  expect(notesOnClip(notes).map((note) => note.text)).toEqual([
    'Final text after reload or seek',
    'Earlier text',
  ])
  expect(notesOnRecording(notes, 1000).map((note) => note.text)).toEqual([
    'Earlier text',
    'Final text after reload or seek',
  ])
})

test('legacy notes use creation time and an empty final note remains authoritative', () => {
  const notes = [
    {
      video_time_seconds: 10,
      client_ts: null,
      text: 'Earlier text',
      created_at: '2026-11-16T12:00:00Z',
    },
    { video_time_seconds: 0, client_ts: null, text: '', created_at: '2026-11-16T12:01:00Z' },
  ]
  expect(latestNote([...notes].reverse())?.text).toBe('')
  expect(latestNote([])).toBeUndefined()
})
