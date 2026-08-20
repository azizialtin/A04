import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { participantApi } from '../api/participant'
import { __reset, drain, enqueue, pending, start, stop, subscribe } from './outbox'

vi.mock('../api/participant', () => ({
  participantApi: { createNote: vi.fn(), logEvent: vi.fn() },
}))

const createNote = vi.mocked(participantApi.createNote)
const logEvent = vi.mocked(participantApi.logEvent)

const httpError = (status: number) => Object.assign(new Error('http'), { response: { status } })
const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  __reset()
  createNote.mockReset().mockResolvedValue({ id: 1 })
  logEvent.mockReset().mockResolvedValue({})
})

afterEach(() => {
  __reset()
  vi.useRealTimers()
})

describe('sending', () => {
  it('delivers queued writes in the order they were made', async () => {
    start('T-001')
    enqueue('note', { video_id: 1, text: 'first' })
    enqueue('note', { video_id: 1, text: 'second' })

    await drain()

    expect(createNote.mock.calls.map(([body]) => body.text)).toEqual(['first', 'second'])
    expect(pending()).toBe(0)
  })

  it('routes each kind to its own endpoint', async () => {
    start('T-001')
    enqueue('note', { video_id: 1, text: 'a note' })
    enqueue('event', { event_type: 'video_started' })

    await drain()

    expect(createNote).toHaveBeenCalledTimes(1)
    expect(logEvent).toHaveBeenCalledTimes(1)
  })

  it('ignores writes made before a participant is signed in', () => {
    enqueue('note', { video_id: 1, text: 'nobody' })
    expect(pending()).toBe(0)
  })
})

describe('failure', () => {
  it('keeps a write that failed on the network, and sends it on the retry', async () => {
    start('T-001')
    createNote.mockRejectedValueOnce(new Error('offline'))
    enqueue('note', { video_id: 1, text: 'survives' })

    await drain()
    expect(pending()).toBe(1)

    await drain()
    expect(pending()).toBe(0)
    expect(createNote).toHaveBeenCalledTimes(2)
  })

  it('holds the order while retrying', async () => {
    start('T-001')
    enqueue('note', { video_id: 1, text: 'first' })
    enqueue('note', { video_id: 1, text: 'second' })
    createNote.mockRejectedValueOnce(new Error('offline'))

    await drain()
    await drain()

    expect(createNote.mock.calls.map(([body]) => body.text)).toEqual([
      'first',
      'first',
      'second',
    ])
  })

  it('drops a write the server will never accept, rather than blocking behind it', async () => {
    start('T-001')
    createNote.mockRejectedValueOnce(httpError(404)) // video not in this run
    enqueue('note', { video_id: 99, text: 'doomed' })
    enqueue('note', { video_id: 1, text: 'fine' })

    await drain()

    expect(pending()).toBe(0)
    expect(createNote).toHaveBeenLastCalledWith(expect.objectContaining({ text: 'fine' }))
  })

  it('stops on 401 and keeps everything for a re-login', async () => {
    start('T-001')
    createNote.mockRejectedValue(httpError(401))
    enqueue('note', { video_id: 1, text: 'held' })

    await drain()

    expect(pending()).toBe(1)
  })

  it('retries a 429 rather than discarding it', async () => {
    start('T-001')
    createNote.mockRejectedValueOnce(httpError(429))
    enqueue('note', { video_id: 1, text: 'later' })

    await drain()
    expect(pending()).toBe(1)
  })
})

describe('ownership', () => {
  it('never sends one participant’s writes as another’s', async () => {
    start('T-001')
    enqueue('note', { video_id: 1, text: 'belongs to T-001' })
    stop()

    start('T-002')
    enqueue('note', { video_id: 1, text: 'belongs to T-002' })
    await drain()

    expect(createNote).toHaveBeenCalledTimes(1)
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({ text: 'belongs to T-002' }))
  })

  it('counts only the signed-in participant’s writes', () => {
    start('T-001')
    createNote.mockRejectedValue(new Error('offline'))
    enqueue('note', { video_id: 1, text: 'mine' })
    stop()

    start('T-002')
    expect(pending()).toBe(0)
  })

  it('picks a previous participant’s writes back up when they return', async () => {
    start('T-001')
    createNote.mockRejectedValueOnce(new Error('offline'))
    enqueue('note', { video_id: 1, text: 'unfinished' })
    await drain()
    stop()

    start('T-001')
    await drain()

    expect(pending()).toBe(0)
  })
})

describe('durability', () => {
  it('keeps unsent writes across a reload', async () => {
    start('T-001')
    createNote.mockRejectedValue(new Error('offline'))
    enqueue('note', { video_id: 1, text: 'not yet sent' })
    await drain()

    // A reload re-imports the module, which reads the queue back off storage.
    expect(JSON.parse(window.localStorage.getItem('a04.outbox')!)).toHaveLength(1)
    expect(JSON.parse(window.localStorage.getItem('a04.outbox')!)[0].body.text).toBe('not yet sent')
  })
})

describe('reporting', () => {
  it('tells subscribers how much is outstanding', async () => {
    let seen = -1
    subscribe((n) => {
      seen = n
    })

    start('T-001')
    createNote.mockRejectedValueOnce(new Error('offline'))
    enqueue('note', { video_id: 1, text: 'one' })
    await drain()
    expect(seen).toBe(1)

    await drain()
    await flushMicrotasks()
    expect(seen).toBe(0)
  })
})
