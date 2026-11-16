import { expect, test, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'

import type { SessionStep } from '../src/api/participant'

const API = 'http://a04.invalid'
const PARTICIPANT = 'QA-NAVIGATION'
const SESSION_ERROR = 'Etwas ist schiefgelaufen. Bitte laden Sie die Seite neu.'

async function setup(page: Page) {
  const state = {
    current: 0,
    failProgress: false,
    sessionReads: 0,
    stepBacks: 0,
    progress: [] as Record<string, unknown>[],
    events: [] as Record<string, unknown>[],
  }
  const steps: SessionStep[] = [
    {
      index: 0,
      completed: false,
      kind: 'case_intro',
      phase_type: 'training',
      video_id: 7,
      case_number: 2,
      case_total: 7,
      title: '',
      body: '',
    },
    {
      index: 1,
      completed: false,
      kind: 'case_video',
      video_id: 7,
      case_number: 2,
      case_total: 7,
      task_description: 'Beobachten Sie den Fall.',
      info_text: '',
      student_task_text: '',
      time_limit_seconds: 600,
    },
    {
      index: 2,
      completed: false,
      kind: 'diagnosis',
      video_id: 7,
      task_description: '',
      section: 'Sicherheit',
      questions: [],
    },
  ]
  await page.addInitScript((id) => {
    const token = `e30.${btoa(JSON.stringify({ sub: id, role: 'participant', exp: 4_000_000_000 }))}.test`
    localStorage.setItem('a04_auth', JSON.stringify({ token }))
    // Exercise the supported no-capture path without opening an OS picker.
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      value: async () => {
        throw new DOMException('Synthetic capture declined', 'NotAllowedError')
      },
      configurable: true,
    })
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
    if (path === '/participant/session') {
      state.sessionReads += 1
      return json({
        flow_version: 'pilot_20261116',
        status: 'active',
        current_step_index: state.current,
        total_steps: steps.length,
        steps,
      })
    }
    if (path === '/participant/session/progress' && method === 'PATCH') {
      const body = request.postDataJSON()
      state.progress.push(body)
      if (state.failProgress) return route.abort('failed')
      if (body.expected_step_index !== state.current)
        return json({ detail: 'The current page has changed.' }, 409)
      state.current = body.current_step_index
      return json({
        status: 'active',
        current_step_index: state.current,
        total_steps: steps.length,
        complete: false,
      })
    }
    if (path === '/participant/session/step-back' && method === 'POST') {
      state.stepBacks += 1
      state.current -= 1
      return json({
        status: 'active',
        current_step_index: state.current,
        total_steps: steps.length,
        complete: false,
      })
    }
    if (path === '/participant/events') {
      state.events.push(request.postDataJSON())
      return json({ status: 'accepted' }, 202)
    }
    if (path === '/participant/videos/7/notes') return json([])
    if (path === '/participant/videos/7/url') return json({ signed_url: `${API}/stimulus.webm` })
    if (path === '/stimulus.webm')
      return route.fulfill({
        contentType: 'video/webm',
        body: await readFile(new URL('./fixtures/stimulus.webm', import.meta.url)),
      })
    if (path === '/gaze/recordings') return json({ recording_id: 1 }, 201)
    if (/^\/gaze\/recordings\/\d+\/(geometry|samples|complete)$/.test(path))
      return json({ status: 'ok' })
    unexpected.push(`${method} ${path}`)
    return json({ detail: 'Unexpected test request' }, 400)
  })
  return { state, unexpected }
}

async function confirmIntro(page: Page) {
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Blickaufzeichnung prüfen' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Ohne Blickdaten fortfahren', exact: true }).click()
}

async function offlineHint(page: Page) {
  // Keep transport available: a browser hint need not mean the local API is
  // unreachable. context.setOffline would test a genuine transport failure.
  await page.evaluate(() => window.dispatchEvent(new Event('offline')))
}

test('a false offline hint permits intro confirmation and sends one progress request', async ({
  page,
}) => {
  const { state, unexpected } = await setup(page)
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Fall 2', exact: true })).toBeVisible()
  await offlineHint(page)
  await confirmIntro(page)
  await expect(page.getByLabel('Notizen', { exact: true })).toBeVisible()
  await expect
    .poll(() =>
      state.events.filter((event) => event.event_type === 'gaze_preflight_continue_without'),
    )
    .toHaveLength(1)
  expect(state.progress).toHaveLength(1)
  expect(state.progress[0]).toMatchObject({ current_step_index: 1, expected_step_index: 0 })
  expect(state.current).toBe(1)
  expect(unexpected).toEqual([])
})

test('a genuine progress transport failure reports an error and permits retry', async ({
  page,
}) => {
  const { state, unexpected } = await setup(page)
  state.failProgress = true
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Fall 2', exact: true })).toBeVisible()
  await confirmIntro(page)
  await expect(page.locator('.toast--error')).toHaveText(SESSION_ERROR)
  await expect(page.getByRole('heading', { name: 'Fall 2', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeEnabled()
  expect(state.current).toBe(0)
  expect(state.progress).toHaveLength(1)

  state.failProgress = false
  await confirmIntro(page)
  await expect(page.getByLabel('Notizen', { exact: true })).toBeVisible()
  expect(state.progress).toHaveLength(2)
  expect(state.current).toBe(1)
  expect(unexpected).toEqual([])
})

test('session refresh and page reload work while the offline hint persists', async ({ page }) => {
  const { state, unexpected } = await setup(page)
  await page.goto('/session')
  await expect(page.getByRole('heading', { name: 'Fall 2', exact: true })).toBeVisible()
  await confirmIntro(page)
  await expect(page.getByLabel('Notizen', { exact: true })).toBeVisible()
  const readsBeforeBack = state.sessionReads
  await offlineHint(page)
  await page.keyboard.press('Control+Alt+Shift+KeyB')
  await page
    .getByRole('dialog', { name: 'Einen Schritt zurück (Studienleitung)' })
    .getByRole('button', { name: 'Zurück', exact: true })
    .click()
  // Step-back invalidates the real session query: it must refetch while the
  // hint stays offline, as well as allowing the step-back mutation itself.
  await expect(page.getByRole('heading', { name: 'Fall 2', exact: true })).toBeVisible()
  await expect.poll(() => state.sessionReads).toBeGreaterThan(readsBeforeBack)
  expect(state.stepBacks).toBe(1)
  expect(state.current).toBe(0)

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'onLine', { get: () => false, configurable: true })
    window.setInterval(() => window.dispatchEvent(new Event('offline')), 20)
  })
  const readsBeforeReload = state.sessionReads
  await page.reload()
  await expect(page.getByRole('heading', { name: 'Fall 2', exact: true })).toBeVisible()
  await expect.poll(() => state.sessionReads).toBeGreaterThan(readsBeforeReload)
  await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false)
  await confirmIntro(page)
  await expect(page.getByLabel('Notizen', { exact: true })).toBeVisible()
  expect(state.current).toBe(1)
  expect(unexpected).toEqual([])
})
