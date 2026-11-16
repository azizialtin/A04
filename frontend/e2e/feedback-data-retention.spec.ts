import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

import type { SessionStep } from '../src/api/participant'

const API = 'http://a04.invalid'
const PARTICIPANT = 'QA-RETENTION'
const note = 'Die letzte Änderung bleibt erhalten.'

async function setup(page: Page, { failing = false, seconds = 600 } = {}) {
  const state = {
    failing,
    current: 0,
    notes: [] as Record<string, unknown>[],
    attempts: [] as Record<string, unknown>[],
    loseNoteAcknowledgement: false,
    failNoteReads: false,
  }
  const steps: SessionStep[] = [
    {
      index: 0,
      completed: false,
      kind: 'case_video',
      video_id: 7,
      title: 'Fall',
      task_description: 'Beobachten Sie den Fall.',
      info_text: '',
      student_task_text: '',
      time_limit_seconds: seconds,
    },
    {
      index: 1,
      completed: false,
      kind: 'diagnosis',
      video_id: 7,
      title: 'Diagnose',
      task_description: '',
      section: 'Sicherheit',
      questions: [],
    },
    {
      index: 2,
      completed: false,
      kind: 'case_outro',
      video_id: 7,
      phase_type: 'pre_test',
      questionnaire_id: 5,
      title: 'Nach dem Fall',
      section: 'Aufwand',
      instruction: '',
      questions: [],
    },
    { index: 3, completed: false, kind: 'thanks' },
  ]
  await page.addInitScript((id) => {
    const token = `e30.${btoa(JSON.stringify({ sub: id, role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
  }, PARTICIPANT)
  await page.routeWebSocket('ws://127.0.0.1:8766', (socket) => {
    socket.send(JSON.stringify({ type: 'status', connected: false, screen_recording: false }))
  })
  const unexpected: string[] = []
  await page.route(`${API}/**`, async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname
    const method = request.method()
    const json = (value: unknown, status = 200) =>
      route.fulfill({ json: value, status, headers: { 'Access-Control-Allow-Origin': '*' } })
    if (method === 'OPTIONS')
      return route.fulfill({
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Headers': '*',
          'Access-Control-Allow-Methods': '*',
        },
      })
    if (path === '/participant/me') return json({ id: PARTICIPANT, status: 'active' })
    if (path === '/participant/session')
      return json({
        status: 'active',
        current_step_index: state.current,
        total_steps: steps.length,
        steps,
      })
    if (path === '/participant/session/progress') {
      state.current = request.postDataJSON().current_step_index
      return json({
        status: 'active',
        current_step_index: state.current,
        total_steps: steps.length,
        complete: false,
      })
    }
    if (path === '/participant/notes') {
      const body = request.postDataJSON()
      state.attempts.push(body)
      if (state.failing) return route.abort('failed')
      if (!state.notes.some((saved) => saved.request_id === body.request_id))
        state.notes.push({ ...body, created_at: new Date().toISOString() })
      if (state.loseNoteAcknowledgement) {
        state.loseNoteAcknowledgement = false
        return route.abort('failed')
      }
      return json({ id: 1 }, 201)
    }
    if (path === '/participant/events') return state.failing ? route.abort('failed') : json({}, 202)
    if (path === '/participant/videos/7/notes')
      return state.failNoteReads
        ? route.abort('failed')
        : json(
            [...state.notes].sort(
              (a, b) => Number(a.video_time_seconds) - Number(b.video_time_seconds),
            ),
          )
    if (path === '/participant/videos/7/url') return json({ signed_url: `${API}/stimulus.webm` })
    if (path === '/stimulus.webm')
      return route.fulfill({
        contentType: 'video/webm',
        body: await readFile(new URL('./fixtures/stimulus.webm', import.meta.url)),
      })
    if (path === '/participant/diagnosis' || path.endsWith('/respond')) return json({ id: 1 }, 201)
    if (path === '/gaze/recordings') return json({ recording_id: 1 }, 201)
    if (/^\/gaze\/recordings\/\d+\/(geometry|samples|complete)$/.test(path))
      return json({ status: 'ok' })
    unexpected.push(`${method} ${path}`)
    return json({ detail: 'Unexpected test request' }, 400)
  })
  return { state, unexpected }
}

test('an immediate reload retains the final edit before the debounce', async ({ page }) => {
  const { state, unexpected } = await setup(page)
  await page.goto('/session')
  await page.getByLabel('Notizen', { exact: true }).fill(note)
  await page.reload()
  await expect(page.getByLabel('Notizen', { exact: true })).toHaveValue(note)
  await expect.poll(() => state.notes.some((saved) => saved.text === note)).toBe(true)
  expect(unexpected).toEqual([])
})

test('timer expiry saves the final edit before diagnosis, including while offline', async ({
  page,
}) => {
  const { state, unexpected } = await setup(page, { failing: true, seconds: 2 })
  await page.clock.install()
  await page.goto('/session')
  await expect(page.getByLabel('Notizen', { exact: true })).toBeVisible()
  await page.clock.runFor(1600)
  await page.getByLabel('Notizen', { exact: true }).fill(note)
  await page.clock.runFor(500)
  await expect(page.locator('#diagnosis-text')).toBeVisible()
  await expect(page.locator('.notes-recap')).toContainText(note)
  state.failing = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => state.notes.some((saved) => saved.text === note)).toBe(true)
  expect(unexpected).toEqual([])
})

test('a queued note remains visible after an offline reload and uses the same retry ID', async ({
  page,
}) => {
  const { state } = await setup(page, { failing: true })
  await page.goto('/session')
  await page.getByLabel('Notizen', { exact: true }).fill(note)
  await page.getByLabel('Notizen', { exact: true }).blur()
  const queued = await page.evaluate(
    () =>
      JSON.parse(localStorage.getItem('a04.outbox') ?? '[]').find(
        (job: { kind: string }) => job.kind === 'note',
      ).body,
  )
  await page.reload()
  await expect(page.getByLabel('Notizen', { exact: true })).toHaveValue(note)
  state.failing = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => state.notes.length).toBe(1)
  expect(state.notes[0]).toMatchObject(queued)
})

test('a crash draft is recovered even without a pagehide event', async ({ page }) => {
  const { state } = await setup(page)
  await page.addInitScript(
    ({ id, text }) => {
      localStorage.setItem(`a04.draft.notes.${id}.7`, text)
      localStorage.setItem('a04.draft.notes.OTHER.7', 'Other participant’s private note')
    },
    { id: PARTICIPANT, text: note },
  )
  await page.goto('/session')
  await expect(page.getByLabel('Notizen', { exact: true })).toHaveValue(note)
  await expect.poll(() => state.notes.length).toBe(1)
  expect(state.notes[0].text).toBe(note)
})

test('recovering a cleared draft saves the deletion and older playhead positions cannot replace it', async ({
  page,
}) => {
  const { state } = await setup(page)
  state.notes.push({
    text: 'Older saved note',
    video_time_seconds: 12,
    client_ts: 1000,
    created_at: '2026-11-16T12:00:00Z',
  })
  await page.addInitScript((id) => {
    if (!localStorage.getItem('qa-empty-draft-seeded')) {
      localStorage.setItem(`a04.draft.notes.${id}.7`, '')
      localStorage.setItem('qa-empty-draft-seeded', '1')
    }
  }, PARTICIPANT)
  await page.goto('/session')
  await expect.poll(() => state.notes.length).toBe(2)
  expect(state.notes[1].text).toBe('')
  await page.reload()
  await expect(page.getByLabel('Notizen', { exact: true })).toHaveValue('')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: 'Zur Diagnose', exact: true }).click()
  await expect(page.locator('.notes-recap')).not.toContainText('Older saved note')
})

test('acknowledged notes remain visible when their subsequent fetch fails', async ({ page }) => {
  const { state } = await setup(page)
  state.notes.push({
    text: 'Older saved note',
    video_time_seconds: 12,
    client_ts: 1000,
    created_at: '2026-11-16T12:00:00Z',
  })
  await page.goto('/session')
  await expect(page.getByLabel('Notizen', { exact: true })).toHaveValue('Older saved note')
  state.failNoteReads = true
  await page.getByLabel('Notizen', { exact: true }).fill(note)
  await page.getByLabel('Notizen', { exact: true }).blur()
  await expect.poll(() => state.notes.length).toBe(2)
  await expect
    .poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('a04.outbox') ?? '[]').length))
    .toBe(0)
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: 'Zur Diagnose', exact: true }).click()
  await expect(page.locator('.notes-recap')).toContainText(note)
  await expect(page.locator('.notes-recap')).not.toContainText('Older saved note')
})

test('a lost note acknowledgement retries the exact same snapshot', async ({ page }) => {
  const { state } = await setup(page)
  state.loseNoteAcknowledgement = true
  await page.goto('/session')
  await page.getByLabel('Notizen', { exact: true }).fill(note)
  await page.getByLabel('Notizen', { exact: true }).blur()
  await expect.poll(() => state.attempts.length).toBeGreaterThanOrEqual(2)
  expect(state.attempts[1]).toEqual(state.attempts[0])
  expect(state.notes).toHaveLength(1)
})

test('an older queued note gains one persistent retry key before sending', async ({ page }) => {
  const { state } = await setup(page, { failing: true })
  await page.addInitScript((id) => {
    if (!localStorage.getItem('a04.outbox'))
      localStorage.setItem(
        'a04.outbox',
        JSON.stringify([
          {
            id: '1700000000000-0',
            owner: id,
            kind: 'note',
            body: {
              video_id: 7,
              text: 'Older queued note',
              client_ts: 1700000000000,
              video_time_seconds: 12,
            },
          },
        ]),
      )
  }, PARTICIPANT)
  await page.goto('/session')
  await expect.poll(() => state.attempts.length).toBeGreaterThan(0)
  const first = state.attempts[0]
  expect(first.request_id).toMatch(/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/)
  await page.reload()
  await expect(page.getByLabel('Notizen', { exact: true })).toHaveValue('Older queued note')
  state.failing = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect.poll(() => state.notes.length).toBe(1)
  expect(state.notes[0]).toMatchObject(first)
  expect(state.attempts.every((body) => body.request_id === first.request_id)).toBe(true)
})

test('end-page reload blocks handoff until own writes recover and isolates other participants', async ({
  page,
}) => {
  const { state, unexpected } = await setup(page, { failing: true })
  await page.addInitScript(() => {
    if (!localStorage.getItem('a04.outbox'))
      localStorage.setItem(
        'a04.outbox',
        JSON.stringify([
          {
            id: 'old-client-id',
            owner: 'OTHER',
            kind: 'note',
            body: { video_id: 7, text: 'Private other note', client_ts: 1, video_time_seconds: 0 },
          },
        ]),
      )
  })
  await page.goto('/session')
  await page.getByLabel('Notizen', { exact: true }).fill(note)
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: 'Zur Diagnose', exact: true }).click()
  await page.locator('#diagnosis-text').fill('Meine Diagnose')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Fall abgeschlossen', exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  const next = page.getByRole('button', { name: 'Mit der nächsten Person beginnen', exact: true })
  await expect(next).toBeDisabled()
  await page.reload()
  await expect(next).toBeDisabled()
  state.failing = false
  await page.evaluate(() => window.dispatchEvent(new Event('online')))
  await expect(next).toBeEnabled()
  expect(state.notes.map((saved) => saved.text)).toEqual([note])
  await next.click()
  await expect(page.getByLabel('Teilnehmer-ID', { exact: true })).toBeVisible()
  const remaining = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('a04.outbox') ?? '[]').map(
      (job: { owner: string }) => job.owner,
    ),
  )
  expect(remaining).toEqual(['OTHER'])
  expect(
    await page.evaluate(() =>
      Object.keys(localStorage).filter((key) => key.startsWith('a04.draft.')),
    ),
  ).toEqual([])
  expect(unexpected).toEqual([])
})
