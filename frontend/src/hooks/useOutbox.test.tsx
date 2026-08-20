import { render } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { __reset, enqueue, pending } from '../lib/outbox'
import { useOutbox } from './useOutbox'

vi.mock('../api/participant', () => ({
  participantApi: { createNote: vi.fn(), logEvent: vi.fn() },
}))

beforeEach(() => __reset())
afterEach(() => __reset())

function CaseScreen() {
  useEffect(() => {
    enqueue('event', { event_type: 'case_screen_entered', video_id: 1 })
    return () => enqueue('event', { event_type: 'case_screen_exited', video_id: 1 })
  }, [])
  return null
}

/** What is still queued for a participant, whether or not sending is running. */
const pendingFor = (id: string) =>
  JSON.parse(window.localStorage.getItem('a04.outbox') ?? '[]').filter(
    (job: { owner: string }) => job.owner === id,
  ).length

function Session() {
  useOutbox('T-001')
  return <CaseScreen />
}

test('a write made as the first screen mounts is not dropped', () => {
  // React runs the child's effect before the parent's, so the outbox has to
  // know whose session it is by then — this is the resume-onto-a-case path.
  render(<Session />)
  expect(pending()).toBe(1)
})

test('a write made as the last screen unmounts is not dropped', () => {
  // The mirror of the case above: React runs the parent's cleanup first, so the
  // outbox is torn down before the case screen logs that it was left.
  const view = render(<Session />)
  view.unmount()
  expect(pendingFor('T-001')).toBe(2)
})
