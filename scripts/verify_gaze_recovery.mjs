/** Real local API/UI/bridge recovery acceptance. Never targets production.
 * A04_QA_API / A04_QA_APP select disposable loopback servers.
 * A04_GAZE_EVIDENCE_DIR selects output; A04_BROWSER_CHANNEL=chrome uses installed Chrome.
 */
import assert from 'node:assert/strict'
import { spawn, execFileSync, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const require = createRequire(path.join(frontend, 'package.json'))
const { chromium, expect } = require('@playwright/test')
function localOrigin(value) {
  const url = new URL(value)
  assert.equal(url.protocol, 'http:', 'QA requires an explicit local HTTP origin')
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
    'Refusing nonloopback QA target',
  )
  assert(!url.username && !url.password && url.pathname === '/' && !url.search && !url.hash)
  assert(url.port, 'QA requires a dedicated local port')
  return url.origin
}
const apiOrigin = localOrigin(process.env.A04_QA_API ?? 'http://127.0.0.1:18052')
const origin = localOrigin(process.env.A04_QA_APP ?? 'http://127.0.0.1:15185')
const output =
  process.env.A04_GAZE_EVIDENCE_DIR ?? (await mkdtemp(path.join(os.tmpdir(), 'a04-gaze-recovery-')))
await mkdir(output, { recursive: true })
const logs = { bridge: '', vite: '' }
const requests = { starts: [], samples: [] }
const failures = []
const httpFailures = []
let browser, bridge, vite, page, study, participantId, absentId
let interrupted
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
async function eventually(check, label, timeout = 20000) {
  const until = Date.now() + timeout
  while (true) {
    const result = await check()
    if (result) return result
    assert(Date.now() < until, label)
    await sleep(150)
  }
}
async function api(endpoint, { token, body, method = 'GET', raw = false } = {}) {
  const response = await fetch(`${apiOrigin}${endpoint}`, {
    method,
    headers: {
      // FFmpeg analysis below blocks this harness's event loop. Avoid reusing
      // an idle socket whose server-side close could not yet be processed.
      Connection: 'close',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  assert(response.ok, `${method} ${endpoint}: ${response.status} ${await response.clone().text()}`)
  return raw ? response : response.status === 204 ? null : response.json()
}
const fixture = path.join(output, 'stimulus.webm')
execFileSync('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=20:duration=12',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=12',
  '-c:v',
  'libvpx',
  '-b:v',
  '180k',
  '-g',
  '20',
  '-c:a',
  'libopus',
  '-shortest',
  fixture,
])
const bytes = await readFile(fixture)
const adminToken = (
  await api('/auth/admin/login', {
    method: 'POST',
    body: {
      email: process.env.A04_QA_EMAIL ?? 'e2e@a04.test',
      password: process.env.A04_QA_PASSWORD ?? 'e2e-password-1234',
    },
  })
).access_token
study = await api('/admin/studies', {
  method: 'POST',
  token: adminToken,
  body: {
    name: `Gaze recovery QA ${Date.now()}`,
    sosci_pretest_url: 'https://sosci.example/pre',
    sosci_posttest_url: 'https://sosci.example/post',
  },
})
const videos = []
for (const phase of ['pre_test', 'training', 'post_test']) {
  const form = new FormData()
  for (const [key, value] of Object.entries({
    title: `Gaze recovery ${phase}`,
    phase_type: phase,
    task_description: 'Watch the synthetic tone fixture.',
    info_text: 'Local recovery acceptance.',
    student_task_text: 'Synthetic students’ soundtrack.',
  }))
    form.set(key, value)
  form.set('file', new Blob([bytes], { type: 'video/webm' }), 'stimulus.webm')
  videos.push(
    await api(`/admin/studies/${study.id}/videos`, {
      method: 'POST',
      token: adminToken,
      body: form,
    }),
  )
}
for (const q of await api(`/admin/studies/${study.id}/questionnaires`, {
  token: adminToken,
})) {
  if (q.placement === 'pre_test')
    await api(`/admin/questionnaires/${q.id}?force=true`, {
      method: 'DELETE',
      token: adminToken,
    })
}
await api(`/admin/studies/${study.id}/questionnaires`, {
  method: 'POST',
  token: adminToken,
  body: {
    placement: 'pre_test',
    title: 'Recovery background',
    order_index: 0,
    questions: [{ id: 'age', type: 'number', text: 'Alter' }],
  },
})
participantId = `GAZE-RECOVERY-${Date.now()}`
absentId = `${participantId}-ABSENT`
await api(`/admin/studies/${study.id}/participants`, {
  method: 'POST',
  token: adminToken,
  body: { ids: [participantId, absentId] },
})
const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const bridgePort = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
const viteModule = path.join(
  path.dirname(require.resolve('vite/package.json')),
  'dist/node/index.js',
)
const reactModule = path.join(path.dirname(require.resolve('@vitejs/plugin-react')), 'index.js')
const serverCode = `import {createServer} from ${JSON.stringify(pathToFileURL(viteModule).href)}; import react from ${JSON.stringify(pathToFileURL(reactModule).href)}; const server=await createServer({root:${JSON.stringify(frontend)},configFile:false,plugins:[react()],cacheDir:${JSON.stringify(path.join(output, 'vite-cache'))},server:{host:'127.0.0.1',port:${new URL(origin).port},strictPort:true,hmr:false}}); await server.listen(); server.printUrls();`
vite = spawn(process.execPath, ['--input-type=module', '-e', serverCode], {
  cwd: frontend,
  env: {
    ...process.env,
    VITE_API_BASE_URL: apiOrigin,
    VITE_TOBII_WS_URL: `ws://127.0.0.1:${bridgePort}`,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
})
for (const stream of [vite.stdout, vite.stderr])
  stream.on('data', (chunk) => {
    logs.vite += chunk
  })
const timeout = setTimeout(() => {
  void browser?.close()
  bridge?.kill('SIGINT')
  vite?.kill('SIGTERM')
}, 240000)
async function newParticipantPage(id) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    acceptDownloads: true,
  })
  await context.addInitScript(() => {
    window.qaSockets = []
    window.qaSocketEvents = []
    window.qaMicRequests = 0
    window.qaDisplayRequests = 0
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      constructor(...args) {
        super(...args)
        this.qaId = window.qaSockets.length
        this.qaKinds = new Set()
        this.qaSamples = 0
        window.qaSockets.push(this)
        this.addEventListener('close', (event) =>
          window.qaSocketEvents.push({
            id: this.qaId,
            type: 'closed',
            wall: Date.now(),
            code: event.code,
          }),
        )
        this.addEventListener('message', (event) => {
          try {
            const message = JSON.parse(event.data)
            if (message.type === 'gaze') this.qaSamples++
            else if (['status', 'gaze_status', 'screen_recording_started'].includes(message.type))
              window.qaSocketEvents.push({
                id: this.qaId,
                type: message.type,
                wall: Date.now(),
                connected: message.connected,
                state: message.state,
                ok: message.ok,
                epoch_ms: message.epoch_ms,
                source_mode: message.source_mode,
              })
          } catch {
            /* non-JSON frames do not affect app handling */
          }
        })
      }
      send(data) {
        if (typeof data === 'string') {
          try {
            const { type, epoch_ms } = JSON.parse(data)
            this.qaKinds.add(type)
            window.qaSocketEvents.push({
              id: this.qaId,
              type,
              epoch_ms,
              wall: Date.now(),
            })
          } catch {
            /* preserve unknown frame handling */
          }
        }
        return super.send(data)
      }
    }
    navigator.mediaDevices.getUserMedia = () => {
      window.qaMicRequests++
      throw new Error('Microphone forbidden in gaze QA')
    }
    navigator.mediaDevices.getDisplayMedia = () => {
      window.qaDisplayRequests++
      throw new DOMException(
        'Synthetic refusal of screen share; bridge absent branch only',
        'NotAllowedError',
      )
    }
  })
  const page = await context.newPage()
  page.setDefaultTimeout(20000)
  page.on('pageerror', (error) => failures.push(String(error)))
  page.on('response', (response) => {
    const url = new URL(response.url())
    if (url.origin === apiOrigin && response.status() >= 400)
      httpFailures.push({ status: response.status(), path: url.pathname })
  })
  const cdp = await context.newCDPSession(page)
  const { targetInfo } = await cdp.send('Target.getTargetInfo')
  for (const name of ['loopback-network', 'local-network-access']) {
    try {
      await cdp.send('Browser.setPermission', {
        permission: { name },
        setting: 'granted',
        origin,
        browserContextId: targetInfo.browserContextId,
      })
    } catch {
      /* browser-version-specific permission names */
    }
  }
  await page.goto(`${origin}/login`)
  await page.getByLabel('Teilnehmer-ID').fill(id)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await page.getByRole('button', { name: 'Los geht’s' }).click()
  await page.getByRole('spinbutton').fill('34')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: /abgeschlossen/ }).click()
  await expect(page.getByText('Phase 1', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Neuer Fall' })).toBeVisible()
  return page
}
async function caseRows() {
  const list = await api(`/admin/gaze/recordings?participant_id=${participantId}`, {
    token: adminToken,
  })
  return list.items.filter(
    (row) =>
      row.step_kind === 'case_video' && row.video_id === videos[0].id && row.replay.kind === 'gaze',
  )
}
try {
  await eventually(async () => {
    try {
      return (await fetch(origin)).ok
    } catch {
      return false
    }
  }, `Vite failed: ${logs.vite}`)
  browser = await chromium.launch({
    headless: true,
    ...(process.env.A04_BROWSER_CHANNEL ? { channel: process.env.A04_BROWSER_CHANNEL } : {}),
  })
  console.log('Checking explicit continuation while the bridge is absent')
  page = await newParticipantPage(absentId)
  await expect(page.locator('.gaze-health')).toContainText('Keine Verbindung zur A04Bridge.')
  await expect(
    page.getByRole('button', {
      name: 'Ohne Blickdaten fortfahren',
      exact: true,
    }),
  ).toBeVisible()
  await page.screenshot({
    path: path.join(output, 'preflight-bridge-absent.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Ohne Blickdaten fortfahren', exact: true }).click()
  await expect(page.locator('video[data-gaze-video]')).toBeVisible({
    timeout: 30000,
  })
  await expect(page.locator('.gaze-health-stack')).toContainText('Keine Verbindung zur A04Bridge.')
  await page.screenshot({
    path: path.join(output, 'explicit-continue-without-gaze.png'),
    fullPage: true,
  })
  const absentStatus = {
    explicitContinuationReachedCase: true,
    screenShareRefusals: await page.evaluate(() => window.qaDisplayRequests),
  }
  await page.context().close()

  page = await newParticipantPage(participantId)
  await expect(page.locator('.gaze-health')).toContainText('Keine Verbindung zur A04Bridge.')
  bridge = spawn(
    process.env.A04_PYTHON ??
      path.join(
        root,
        process.platform === 'win32'
          ? 'backend/.venv/Scripts/python.exe'
          : 'backend/.venv/bin/python',
      ),
    [
      '-u',
      'tobii_bridge.py',
      '--mock',
      '--screen-source',
      'test-pattern',
      '--screen-max-height',
      '180',
      '--screen-fps',
      '10',
      '--port',
      String(bridgePort),
      '--allow-origin',
      origin,
    ],
    {
      cwd: path.join(root, 'tobii-service'),
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )
  for (const stream of [bridge.stdout, bridge.stderr])
    stream.on('data', (chunk) => {
      logs.bridge += chunk
    })
  await eventually(
    () => logs.bridge.includes('listening on'),
    'Actual Python mock bridge did not start',
  )
  await page.getByRole('button', { name: 'Eye-Tracker erneut prüfen', exact: true }).click()
  await expect(page.locator('.gaze-health--ready')).toContainText(
    'Testmodus: synthetische Blickdaten',
  )
  await expect(page.locator('.gaze-health--ready')).toContainText('Blickdaten werden empfangen.')
  await expect(page.getByRole('button', { name: 'Weiter', exact: true })).toBeVisible()
  await page.screenshot({
    path: path.join(output, 'preflight-mock-live.png'),
    fullPage: true,
  })
  let failedCreate = false
  await page.route(`${apiOrigin}/gaze/recordings`, async (route) => {
    if (route.request().method() !== 'POST') return route.continue()
    const body = route.request().postDataJSON()
    if (body.step_kind === 'case_video' && !failedCreate) {
      failedCreate = true
      requests.starts.push({
        status: 500,
        step_kind: body.step_kind,
        geometry_ts: body.geometry?.ts,
        wall: Date.now(),
      })
      return route.fulfill({
        status: 500,
        json: { detail: 'Synthetic transient recording creation failure' },
      })
    }
    const response = await route.fetch()
    const payload = await response.json()
    requests.starts.push({
      status: response.status(),
      recording_id: payload.recording_id,
      step_kind: body.step_kind,
      geometry_ts: body.geometry?.ts,
      wall: Date.now(),
    })
    await route.fulfill({ response })
  })
  await page.route(new RegExp(`${apiOrigin}/gaze/recordings/[0-9]+/samples$`), async (route) => {
    const body = route.request().postDataJSON()
    const response = await route.fetch()
    const result = await response.json()
    requests.samples.push({
      recording_id: Number(
        route
          .request()
          .url()
          .match(/recordings\/(\d+)/)[1],
      ),
      offset: body.offset,
      count: body.samples.length,
      first_ts: body.samples[0]?.ts,
      last_ts: body.samples.at(-1)?.ts,
      monotonic: body.samples.every(
        (sample, index) => index === 0 || sample.ts >= body.samples[index - 1].ts,
      ),
      status: response.status(),
      total: result.total_sample_count,
    })
    await route.fulfill({ response })
  })
  console.log('Checking one transient recording-start failure and retry')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  const video = page.locator('video[data-gaze-video]')
  await expect(video).toBeVisible()
  await expect(page.locator('.gaze-health-stack')).toContainText(
    'Blickaufzeichnung konnte auf dem Server nicht angelegt werden.',
  )
  await page.screenshot({
    path: path.join(output, 'recording-create-failure.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Eye-Tracker erneut prüfen', exact: true }).click()
  await expect(page.locator('.gaze-health--ready')).toContainText('Blickdaten werden empfangen.')
  await page.waitForFunction(() =>
    window.qaSocketEvents.some(
      (item) => item.type === 'screen_recording_started' && item.ok === true,
    ),
  )
  await page.waitForFunction(
    () => document.querySelector('video[data-gaze-video]')?.readyState >= 2,
  )
  await page.getByRole('button', { name: 'Abspielen', exact: true }).click()
  const firstRows = await eventually(async () => {
    const rows = await caseRows()
    return rows.length === 1 && rows[0].sample_count > 0 ? rows : false
  }, 'Case did not store initial gaze samples')
  const firstRow = firstRows[0]
  console.log('Interrupting only the measured gaze socket while native screen/audio continues')
  interrupted = await page.evaluate(() => {
    const screen = window.qaSockets.find(
      (socket) =>
        socket.readyState === WebSocket.OPEN && socket.qaKinds.has('start_screen_recording'),
    )
    const gaze = window.qaSockets.find(
      (socket) =>
        socket.readyState === WebSocket.OPEN &&
        socket.qaKinds.has('start_gaze') &&
        !socket.qaKinds.has('start_screen_recording'),
    )
    if (!screen || !gaze) throw new Error('Expected distinct live screen and gaze sockets')
    const result = {
      gazeId: gaze.qaId,
      screenId: screen.qaId,
      samplesBefore: gaze.qaSamples,
      wall: Date.now(),
      stimulusAudioEpoch: window.qaSocketEvents.find(
        (event) => event.id === screen.qaId && event.type === 'start_stimulus_audio',
      )?.epoch_ms,
    }
    gaze.close(1000, 'Synthetic gaze-only transport interruption')
    return result
  })
  assert(Number.isFinite(interrupted.stimulusAudioEpoch), 'Native audio clock was established')
  await expect(page.locator('.gaze-health-stack')).toContainText('Keine Verbindung zur A04Bridge.')
  await page.screenshot({
    path: path.join(output, 'gaze-socket-interrupted.png'),
    fullPage: true,
  })
  await expect(page.locator('.gaze-health--ready')).toContainText('Blickdaten werden empfangen.', {
    timeout: 20000,
  })
  await page.waitForFunction(
    (oldId) => window.qaSockets.some((socket) => socket.qaId > oldId && socket.qaSamples > 5),
    interrupted.gazeId,
  )
  const during = await page.evaluate(
    (screenId) => ({
      screenOpen: window.qaSockets[screenId].readyState === WebSocket.OPEN,
      screenStarts: window.qaSocketEvents.filter((item) => item.type === 'start_screen_recording')
        .length,
      audioStarts: window.qaSocketEvents
        .filter((item) => item.type === 'start_stimulus_audio')
        .map((item) => item.epoch_ms),
    }),
    interrupted.screenId,
  )
  assert(during.screenOpen, 'Gaze interruption must leave native recording socket open')
  assert.equal(during.screenStarts, 1)
  assert.deepEqual(during.audioStarts, [interrupted.stimulusAudioEpoch])
  await page.getByLabel('Notizen', { exact: true }).fill('Recovery note after gaze reconnect')
  await page.getByLabel('Notizen', { exact: true }).blur()
  await page.waitForFunction(() => document.querySelector('video[data-gaze-video]').ended, {
    timeout: 20000,
  })
  await page.screenshot({
    path: path.join(output, 'gaze-recovered.png'),
    fullPage: true,
  })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click({ trial: true })
  await page.setViewportSize({ width: 1366, height: 768 })
  await page.screenshot({ path: path.join(output, 'gaze-recovered-1366x768.png'), fullPage: true })
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByLabel('Was war das Problem?').fill('Synthetic recovery diagnosis')
  await page.getByRole('slider').click()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Fall abgeschlossen' })).toBeVisible()
  await page.getByRole('slider').first().press('ArrowRight')
  await page.getByRole('slider').last().press('ArrowRight')
  for (const statement of [/authentisch/, /Anforderungssituation/])
    await page
      .getByRole('group', { name: statement })
      .getByRole('radio', { name: '5', exact: true })
      .check()
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Lautes Denken' })).toBeVisible({ timeout: 65000 })
  const replay = await page.evaluate(
    async (id) => (await import('/src/api/participant.ts')).participantApi.getVideoReplay(id),
    videos[0].id,
  )
  assert.equal(replay.source, 'screen')
  assert.equal(replay.recorder, 'bridge')
  assert.equal(replay.audio_status, 'captured')
  assert(replay.plotted_points > 100)
  await page.waitForFunction(async () => (await import('/src/lib/outbox.ts')).pending() === 0)
  const notes = await page.evaluate(
    async (id) => (await import('/src/api/participant.ts')).participantApi.getVideoNotes(id),
    videos[0].id,
  )
  assert(
    notes.some((note) => note.text === 'Recovery note after gaze reconnect' && note.client_ts),
    'The note entered after gaze recovery must reach storage with its clock anchor',
  )
  const finalRows = await eventually(async () => {
    const rows = await caseRows()
    return rows.length === 1 && rows[0].completed_at ? rows : false
  }, 'Completed gaze row not available')
  const row = finalRows[0]
  assert.equal(row.replay.id, firstRow.replay.id, 'Reconnect must retain the same recording row')
  assert.equal(
    row.started_at,
    firstRow.started_at,
    'Reconnect must preserve the original recording start',
  )
  const starts = requests.starts.filter((item) => item.step_kind === 'case_video')
  assert.deepEqual(
    starts.map((item) => item.status),
    [500, 201],
  )
  assert.equal(
    starts[0].geometry_ts,
    starts[1].geometry_ts,
    'Creation retry must preserve initial geometry timestamp',
  )
  const uploads = requests.samples.filter((item) => item.recording_id === row.replay.id)
  let total = 0
  let lastTimestamp = -Infinity
  for (const upload of uploads) {
    assert.equal(upload.status, 200)
    assert.equal(upload.offset, total, 'Gaze offset must continue across the reconnect')
    assert(upload.monotonic, 'Samples within each saved batch must remain ordered')
    assert(
      upload.first_ts >= lastTimestamp,
      'Sample timestamps must remain ordered across reconnect',
    )
    lastTimestamp = upload.last_ts
    total += upload.count
    assert.equal(upload.total, total)
  }
  assert.equal(row.sample_count, total)
  assert(total > firstRow.sample_count)
  const raw = await api(`/admin/studies/${study.id}/export/gaze?participant_ids=${participantId}`, {
    token: adminToken,
    raw: true,
  })
  const csv = await raw.text()
  await writeFile(path.join(output, 'gaze.csv'), csv)
  const eventCsv = await (
    await api(`/admin/studies/${study.id}/export/events`, {
      token: adminToken,
      raw: true,
    })
  ).text()
  await writeFile(path.join(output, 'events.csv'), eventCsv)
  assert(
    eventCsv.includes('gaze_capture_status'),
    'Gaze health changes must reach the research event log',
  )
  assert(
    eventCsv.includes('gaze_preflight_continue_without'),
    'Explicit unverified continuation must be logged',
  )
  const lines = csv
    .replace(/^\uFEFF/, '')
    .trim()
    .split(/\r?\n/)
  const header = lines.shift().split(',')
  const recordingColumn = header.indexOf('recording_id')
  assert(recordingColumn >= 0)
  assert.equal(
    lines.filter((line) => line.split(',')[recordingColumn] === String(row.replay.id)).length,
    total,
    'Raw stored CSV samples must match the acknowledged case offsets',
  )
  const target = replay.points.find((point) => point.t > 800)?.t / 1000
  assert(Number.isFinite(target))
  await page.locator('.replay__video').evaluate(async (node, position) => {
    if (node.readyState < 2)
      await new Promise((resolve) => node.addEventListener('loadeddata', resolve, { once: true }))
    const done = new Promise((resolve) => node.addEventListener('seeked', resolve, { once: true }))
    node.currentTime = position
    await done
  }, target)
  await expect(page.locator('.gaze-dot')).toHaveCSS('opacity', '1')
  await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).uncheck()
  await expect(page.locator('.gaze-dot')).toHaveCSS('opacity', '0')
  await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).check()
  await expect(page.locator('.gaze-dot')).toHaveCSS('opacity', '1')
  await page.screenshot({
    path: path.join(output, 'replay-gaze-visible.png'),
    fullPage: true,
  })
  const recordingUrl = new URL(replay.video_url, apiOrigin)
  assert.equal(recordingUrl.origin, apiOrigin)
  const recording = Buffer.from(await (await fetch(recordingUrl)).arrayBuffer())
  const recordingFile = path.join(output, 'native-replay.mp4')
  await writeFile(recordingFile, recording)
  const probe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', recordingFile], {
      encoding: 'utf8',
    }),
  )
  assert(
    probe.streams.some((stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac'),
  )
  const pcmResult = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      recordingFile,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { maxBuffer: 20000000 },
  )
  assert.equal(pcmResult.status, 0)
  const pcm = new Float32Array(
    pcmResult.stdout.buffer,
    pcmResult.stdout.byteOffset,
    pcmResult.stdout.length / 4,
  )
  const aroundDrop = (interrupted.wall - replay.epoch_ms) / 1000
  const rms = (from, to) => {
    const values = pcm.slice(Math.round(from * 48000), Math.round(to * 48000))
    return Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length)
  }
  assert(rms(aroundDrop - 0.4, aroundDrop - 0.1) > 0.03)
  assert(
    rms(aroundDrop + 0.2, aroundDrop + 0.5) > 0.03,
    'Student soundtrack continues across gaze-only interruption',
  )
  const adminReplay = await api(`/admin/gaze/recordings/${row.replay.id}/replay`, {
    token: adminToken,
  })
  assert.equal(adminReplay.epoch_ms, replay.epoch_ms)
  assert.equal(adminReplay.audio_status, 'captured')
  assert.deepEqual(adminReplay.points, replay.points)
  const download = await api(`/admin/screen-recordings/${row.screen.id}/download-url`, {
    token: adminToken,
  })
  const downloadUrl = new URL(download.url, apiOrigin)
  assert.equal(downloadUrl.origin, apiOrigin)
  assert(Buffer.from(await (await fetch(downloadUrl)).arrayBuffer()).equals(recording))
  assert.equal(await page.evaluate(() => window.qaMicRequests), 0)
  assert.equal(
    await page.evaluate(() => window.qaDisplayRequests),
    0,
    'Main session must stay on the native bridge path',
  )
  assert.deepEqual(failures, [])
  assert.deepEqual(
    httpFailures,
    [{ status: 500, path: '/gaze/recordings' }],
    'Only the deliberately injected creation failure is expected',
  )
  const report = {
    status: 'passed',
    browser: browser.version(),
    apiOrigin,
    origin,
    studyId: study.id,
    participantId,
    absentId,
    absentStatus,
    gazeRecording: row,
    interrupted,
    during,
    requests,
    httpFailures,
    replay: { ...replay, points: undefined, video_url: undefined },
    audio: {
      probe,
      beforeDropRms: rms(aroundDrop - 0.4, aroundDrop - 0.1),
      afterDropRms: rms(aroundDrop + 0.2, aroundDrop + 0.5),
    },
    limitations: [
      'Real local UI/API/database/media/bridge protocol; Tobii and desktop source are synthetic.',
      'One recording creation failure and a gaze-only socket close were deliberately injected.',
      'Absent-bridge continuation injects screen-picker refusal; main capture uses actual FFmpeg bridge and actual encoded student audio.',
      'Does not verify physical Tobii hardware or the lab Windows browser.',
    ],
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        output,
        studyId: study.id,
        participantId,
        savedCaseSamples: total,
        replayPoints: replay.plotted_points,
        audioStatus: replay.audio_status,
        browser: browser.version(),
      },
      null,
      2,
    ),
  )
} finally {
  clearTimeout(timeout)
  if (page && !page.isClosed()) {
    await page
      .screenshot({
        path: path.join(output, 'last-screen.png'),
        fullPage: true,
      })
      .catch(() => {})
    await writeFile(
      path.join(output, 'last-screen.txt'),
      await page
        .locator('body')
        .innerText()
        .catch(() => ''),
    )
    await writeFile(
      path.join(output, 'socket-events.json'),
      JSON.stringify(await page.evaluate(() => window.qaSocketEvents).catch(() => []), null, 2),
    )
  }
  await browser?.close()
  bridge?.kill('SIGINT')
  vite?.kill('SIGTERM')
  await writeFile(path.join(output, 'bridge.log'), logs.bridge)
  await writeFile(path.join(output, 'vite.log'), logs.vite)
  await writeFile(
    path.join(output, 'partial.json'),
    JSON.stringify(
      {
        studyId: study?.id,
        participantId,
        absentId,
        requests,
        failures,
        httpFailures,
        interrupted,
      },
      null,
      2,
    ),
  )
}
