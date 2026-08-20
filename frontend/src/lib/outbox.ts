/**
 * A durable queue for the writes a participant never waits on — note snapshots
 * and playback events.
 *
 * These used to be fire-and-forget mutations with no retry and an empty catch:
 * a few seconds of bad network during a case silently deleted notes the
 * participant had watched themselves type, and losing a `video_started` event
 * quietly breaks the gaze replay for that clip. A session is one sitting and
 * cannot be repeated, so the queue survives a reload, retries with backoff, and
 * makes anything still unsent visible on screen.
 *
 * Gaze samples deliberately do not come through here — at 120 Hz they are
 * far too many for localStorage, and useGazeCapture retries them in memory.
 */

import type { AxiosError } from 'axios'

import { participantApi } from '../api/participant'
import { queryClient } from '../queryClient'

export type OutboxKind = 'note' | 'event'

export interface OutboxJob {
  id: string
  owner: string // participant id: one participant's data must never go up as another's
  kind: OutboxKind
  body: Record<string, unknown>
}

const STORAGE_KEY = 'a04.outbox'
const MAX_JOBS = 500
const BASE_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000

let queue: OutboxJob[] = load()
let owner: string | null = null
// Whether the queue is allowed to send. Kept apart from `owner` so that a
// screen tearing down can still queue its last writes: React runs a parent's
// effect cleanup before its children's, so the session shuts the outbox down
// before the case screen has logged that it was left.
let sending = false
let timer: number | undefined
let backoff = BASE_BACKOFF_MS
let draining = false
let nextId = 0

const listeners = new Set<(pending: number) => void>()

function load(): OutboxJob[] {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function persist() {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(queue))
  } catch {
    /* storage full or disabled — the queue still works for this page */
  }
  listeners.forEach((fn) => fn(pending()))
}

/** How many of the current participant's writes have not landed yet. */
export function pending(): number {
  if (owner === null || !sending) return 0
  return queue.filter((job) => job.owner === owner).length
}

export function subscribe(fn: (count: number) => void): () => void {
  listeners.add(fn)
  fn(pending())
  return () => listeners.delete(fn)
}

export function enqueue(kind: OutboxKind, body: Record<string, unknown>) {
  if (owner === null) return
  queue.push({ id: `${Date.now()}-${nextId++}`, owner, kind, body })
  if (queue.length > MAX_JOBS) queue = queue.slice(-MAX_JOBS)
  persist()
  if (sending) schedule(0)
}

const send: Record<OutboxKind, (body: never) => Promise<unknown>> = {
  note: (body) => participantApi.createNote(body),
  event: (body) => participantApi.logEvent(body),
}

/** 4xx means the request will never be accepted; retrying it blocks the queue. */
function isPermanent(error: unknown): boolean {
  const status = (error as AxiosError)?.response?.status
  if (typeof status !== 'number') return false
  return status >= 400 && status < 500 && status !== 408 && status !== 429
}

function isUnauthorised(error: unknown): boolean {
  return (error as AxiosError)?.response?.status === 401
}

function schedule(delay: number) {
  if (timer !== undefined) window.clearTimeout(timer)
  timer = window.setTimeout(() => void drain(), delay)
}

export async function drain(): Promise<void> {
  if (draining || !sending || owner === null) return
  draining = true
  try {
    while (queue.length) {
      const job = queue[0]
      if (job.owner !== owner) {
        // Left over from a previous participant on this machine. Keep it — they
        // may log back in — but skip past it rather than send it as this one.
        const mine = queue.findIndex((j) => j.owner === owner)
        if (mine === -1) return
        queue = [...queue.slice(mine), ...queue.slice(0, mine)]
        continue
      }
      try {
        await send[job.kind](job.body as never)
        queue.shift()
        backoff = BASE_BACKOFF_MS
        persist()
        // The diagnosis screen shows these notes back to the participant, and
        // the case screen restores them on a reload. Both read a cached query
        // that was filled in before this note existed.
        if (job.kind === 'note') {
          void queryClient.invalidateQueries({ queryKey: ['notes', job.body.video_id] })
        }
      } catch (error) {
        if (isUnauthorised(error)) return // the session is over; auth will handle it
        if (isPermanent(error)) {
          console.warn('outbox: dropping a write the server refused', job.kind, error)
          queue.shift()
          persist()
          continue
        }
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
        schedule(backoff)
        return
      }
    }
  } finally {
    draining = false
  }
}

/** Begin draining for a participant. Safe to call on every render pass. */
export function start(participantId: string) {
  if (owner === participantId && sending) return
  owner = participantId
  sending = true
  backoff = BASE_BACKOFF_MS
  listeners.forEach((fn) => fn(pending()))
  schedule(0)
}

/** Stop sending. Anything still queued waits for the next `start`. */
export function stop() {
  sending = false
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  listeners.forEach((fn) => fn(0))
}

/** Test seam: reset module state between cases. */
export function __reset() {
  queue = []
  owner = null
  sending = false
  backoff = BASE_BACKOFF_MS
  draining = false
  if (timer !== undefined) window.clearTimeout(timer)
  timer = undefined
  listeners.clear()
  try {
    window.localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* nothing to clear */
  }
}
