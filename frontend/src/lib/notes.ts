import type { NoteSnapshot } from '../api/participant'

/** Editing and diagnosis follow writing time, even after seeking the clip backwards. */
export function latestNote(notes: NoteSnapshot[]): NoteSnapshot | undefined {
  let latest: NoteSnapshot | undefined
  let latestTime = -Infinity
  for (const note of notes) {
    const time = note.client_ts ?? Date.parse(note.created_at)
    if (!latest || !Number.isFinite(time) || time >= latestTime) {
      latest = note
      latestTime = Number.isFinite(time) ? time : latestTime
    }
  }
  return latest
}
