/** Full A04 UI + disposable live API + mock-hardware bridge acceptance.
 * A04_QA_API, A04_QA_EMAIL, A04_QA_PASSWORD and A04_PYTHON select the QA stack.
 * Uses actual components, uploads, replay, gaze and downloads. Only Tobii/display
 * hardware is synthetic. Cases 2/3 route media to real CORS/stall HTTP fixtures.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const require = createRequire(path.join(frontend, 'package.json'))
const { chromium, expect } = require('@playwright/test')
const apiOrigin = process.env.A04_QA_API ?? 'http://127.0.0.1:18032'
const origin = process.env.A04_QA_APP ?? 'http://127.0.0.1:15175'
const output =
  process.env.A04_AUDIO_EVIDENCE_DIR ??
  (await mkdtemp(path.join(os.tmpdir(), 'a04-native-session-')))
await mkdir(output, { recursive: true })
const stimulusPath = path.join(output, 'stimulus.webm')
execFileSync('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  'testsrc2=size=320x180:rate=30:duration=6',
  '-f',
  'lavfi',
  '-i',
  'sine=frequency=440:sample_rate=48000:duration=6',
  '-c:v',
  'libvpx',
  '-b:v',
  '200k',
  '-g',
  '15',
  '-c:a',
  'libopus',
  '-cluster_time_limit',
  '500',
  '-shortest',
  stimulusPath,
])
const stimulusBytes = await readFile(stimulusPath)
async function api(endpoint, { token, body, method = 'GET' } = {}) {
  const response = await fetch(`${apiOrigin}${endpoint}`, {
    method,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
  })
  assert(response.ok, `${method} ${endpoint}: ${response.status} ${await response.clone().text()}`)
  return response.status === 204 ? null : response.json()
}
const adminToken = (
  await api('/auth/admin/login', {
    method: 'POST',
    body: {
      email: process.env.A04_QA_EMAIL ?? 'e2e@a04.test',
      password: process.env.A04_QA_PASSWORD ?? 'e2e-password-1234',
    },
  })
).access_token
const study = await api('/admin/studies', {
  method: 'POST',
  token: adminToken,
  body: {
    name: `Audio full UI QA ${Date.now()}`,
    sosci_pretest_url: 'https://sosci.example/pre',
    sosci_posttest_url: 'https://sosci.example/post',
  },
})
const videos = []
for (const [index, phase] of ['pre_test', 'training', 'post_test'].entries()) {
  const form = new FormData()
  form.set('title', `Audio QA ${index + 1}`)
  form.set('phase_type', phase)
  form.set('task_description', `Audio task ${index + 1}`)
  form.set('info_text', 'Audio testing fixture')
  form.set('student_task_text', 'Discuss the students’ conversation.')
  form.set('file', new Blob([stimulusBytes], { type: 'video/webm' }), 'stimulus.webm')
  videos.push(
    await api(`/admin/studies/${study.id}/videos`, {
      method: 'POST',
      token: adminToken,
      body: form,
    }),
  )
}
for (const q of await api(`/admin/studies/${study.id}/questionnaires`, { token: adminToken })) {
  if (q.placement === 'pre_test')
    await api(`/admin/questionnaires/${q.id}?force=true`, { method: 'DELETE', token: adminToken })
}
await api(`/admin/studies/${study.id}/questionnaires`, {
  method: 'POST',
  token: adminToken,
  body: {
    placement: 'pre_test',
    title: 'Audio QA background',
    order_index: 0,
    questions: [{ id: 'age', type: 'number', text: 'Alter' }],
  },
})
const participantId = `AUDIO-QA-${Date.now()}`
await api(`/admin/studies/${study.id}/participants`, {
  method: 'POST',
  token: adminToken,
  body: { ids: [participantId] },
})
const clusters = []
for (
  let position = 0;
  (position = stimulusBytes.indexOf(Buffer.from([0x1f, 0x43, 0xb6, 0x75]), position)) !== -1;
  position++
)
  clusters.push(position)
assert(clusters.length > 3, 'fixture has enough streaming clusters')
const cut = clusters[3]
let releaseAt = 0
const mediaRequests = []
const media = createServer((req, res) => {
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Number(range[2]) : stimulusBytes.length - 1
  const stalled = req.url.startsWith('/stall')
  mediaRequests.push({
    path: req.url,
    start,
    end,
    origin: req.headers.origin ?? null,
    wall: Date.now(),
  })
  res.writeHead(range ? 206 : 200, {
    'Content-Type': 'video/webm',
    'Accept-Ranges': 'bytes',
    'Content-Length': String(end - start + 1),
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${stimulusBytes.length}` } : {}),
    ...(req.url.startsWith('/nocors') ? {} : { 'Access-Control-Allow-Origin': origin }),
  })
  if (!stalled) {
    res.end(stimulusBytes.subarray(start, end + 1))
    return
  }
  if (!releaseAt) releaseAt = Date.now() + 6500
  const firstEnd = Math.min(cut, end + 1)
  if (start < firstEnd) res.write(stimulusBytes.subarray(start, firstEnd))
  setTimeout(
    () => {
      if (!res.destroyed) res.end(stimulusBytes.subarray(Math.max(start, cut), end + 1))
    },
    Math.max(0, releaseAt - Date.now()),
  )
})
await new Promise((resolve) => media.listen(0, '127.0.0.1', resolve))
const mediaOrigin = `http://127.0.0.1:${media.address().port}`
const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const bridgePort = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
const logs = { bridge: '', vite: '' }
const bridge = spawn(
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
  { cwd: path.join(root, 'tobii-service'), stdio: ['ignore', 'pipe', 'pipe'] },
)
for (const stream of [bridge.stdout, bridge.stderr])
  stream.on('data', (chunk) => {
    logs.bridge += chunk
  })
const viteModule = path.join(
  path.dirname(require.resolve('vite/package.json')),
  'dist/node/index.js',
)
const reactModule = path.join(path.dirname(require.resolve('@vitejs/plugin-react')), 'index.js')
const serverCode = `import {createServer} from ${JSON.stringify(pathToFileURL(viteModule).href)};
import react from ${JSON.stringify(pathToFileURL(reactModule).href)};
const server=await createServer({root:${JSON.stringify(frontend)},configFile:false,plugins:[react()],cacheDir:${JSON.stringify(path.join(output, 'vite-cache'))},server:{host:'127.0.0.1',port:${new URL(origin).port},strictPort:true,hmr:false}});await server.listen();server.printUrls();`
const vite = spawn(process.execPath, ['--input-type=module', '-e', serverCode], {
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
let browser
const captures = []
const failures = []
const timer = setTimeout(() => {
  void browser?.close()
  bridge.kill('SIGINT')
  vite.kill('SIGTERM')
  media.close()
}, 240000)
try {
  const deadline = Date.now() + 20000
  while (true) {
    try {
      if ((await fetch(origin)).ok && logs.bridge.includes('listening on')) break
    } catch {
      /* startup */
    }
    assert(Date.now() < deadline, `servers failed: ${JSON.stringify(logs)}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    acceptDownloads: true,
  })
  await context.grantPermissions(['local-network-access'], { origin })
  await context.addInitScript(() => {
    window.qaMediaEvents = []
    window.qaPlayheadSamples = []
    window.qaCase = 0
    window.qaMicRequests = 0
    window.qaRecorderEvents = []
    window.qaSocketMessages = []
    const NativeRecorder = window.MediaRecorder
    window.MediaRecorder = class extends NativeRecorder {
      constructor(...args) {
        super(...args)
        for (const kind of ['start', 'stop', 'error', 'dataavailable'])
          this.addEventListener(kind, (event) =>
            window.qaRecorderEvents.push({
              case: window.qaCase,
              kind,
              wall: Date.now(),
              size: event.data?.size ?? null,
              mime: this.mimeType,
            }),
          )
      }
    }
    const NativeSocket = window.WebSocket
    window.WebSocket = class extends NativeSocket {
      send(data) {
        if (typeof data === 'string') {
          try {
            const { type, epoch_ms, mime_type, audio_status, audio_error } = JSON.parse(data)
            window.qaSocketMessages.push({
              case: window.qaCase,
              wall: Date.now(),
              type,
              epoch_ms,
              mime_type,
              audio_status,
              audio_error,
            })
          } catch {
            /* non-JSON diagnostic */
          }
        } else
          window.qaSocketMessages.push({
            case: window.qaCase,
            wall: Date.now(),
            type: 'binary',
            size: data.byteLength ?? data.size,
          })
        return super.send(data)
      }
    }

    navigator.mediaDevices.getUserMedia = () => {
      window.qaMicRequests++
      throw new Error('Microphone request forbidden')
    }
    navigator.mediaDevices.getDisplayMedia = () => {
      throw new Error('The real bridge should record this test')
    }
    setInterval(() => {
      const video = document.querySelector('video[data-gaze-video]')
      if (video)
        window.qaPlayheadSamples.push({
          case: window.qaCase,
          wall: Date.now(),
          time: video.currentTime,
          paused: video.paused,
          ended: video.ended,
          readyState: video.readyState,
          seeking: video.seeking,
        })
    }, 100)
    const observed = new WeakSet()
    new MutationObserver(() => {
      for (const video of document.querySelectorAll('video[data-gaze-video]')) {
        if (observed.has(video)) continue
        observed.add(video)
        for (const kind of ['playing', 'waiting', 'pause', 'ended', 'error', 'seeked'])
          video.addEventListener(kind, () =>
            window.qaMediaEvents.push({
              kind,
              case: window.qaCase,
              time: video.currentTime,
              wall: Date.now(),
              crossOrigin: video.crossOrigin,
            }),
          )
      }
    }).observe(document, { childList: true, subtree: true })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(15000)
  page.on('pageerror', (error) => failures.push(String(error)))
  await page.route(`${apiOrigin}/participant/videos/${videos[1].id}/url`, (route) =>
    route.fulfill({
      json: { signed_url: `${mediaOrigin}/nocors.webm` },
      headers: { 'Access-Control-Allow-Origin': origin },
    }),
  )
  await page.route(`${apiOrigin}/participant/videos/${videos[2].id}/url`, (route) =>
    route.fulfill({
      json: { signed_url: `${mediaOrigin}/stall.webm` },
      headers: { 'Access-Control-Allow-Origin': origin },
    }),
  )
  await page.goto(`${origin}/login`)
  await page.getByLabel('Teilnehmer-ID').fill(participantId)
  await page.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await page.getByRole('button', { name: 'Los geht’s' }).click()
  await page.getByRole('spinbutton').fill('34')
  await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  await page.getByRole('button', { name: /abgeschlossen/ }).click()
  for (let index = 0; index < videos.length; index++) {
    console.log(`Starting native case ${index + 1}`)
    await expect(page.getByText(`Phase ${index + 1}`, { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Neuer Fall' })).toBeVisible()
    await page.evaluate((value) => {
      window.qaCase = value
    }, index + 1)
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    const video = page.locator('video[data-gaze-video]')
    await expect(video).toBeVisible()
    await page.waitForFunction(
      () => document.querySelector('video[data-gaze-video]')?.readyState >= 2,
    )
    if (index === 1) {
      await expect(video).not.toHaveAttribute('crossorigin')
      await expect(page.locator('.case-video [role="status"]')).toBeVisible()
    } else await expect(video).toHaveAttribute('crossorigin', 'anonymous')
    // Wait for ffmpeg's first frames so this test deliberately includes a full recording.
    await page.waitForTimeout(index === 2 ? 100 : 600)
    await page.getByRole('button', { name: 'Abspielen', exact: true }).click()
    if (index === 0) {
      await page.waitForFunction(
        () => document.querySelector('video[data-gaze-video]').currentTime > 1.2,
      )
      await page.getByRole('button', { name: 'Pause', exact: true }).click()
      await page.getByLabel('Notizen', { exact: true }).fill('Audio QA note at the pause')
      await page.getByLabel('Notizen', { exact: true }).blur()
      await page.waitForTimeout(800)
      await page.getByRole('button', { name: 'Abspielen', exact: true }).click()
    }
    await page.waitForFunction(() => document.querySelector('video[data-gaze-video]').ended, {
      timeout: 20000,
    })
    await page.screenshot({ path: path.join(output, `case-${index + 1}.png`), fullPage: true })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await page.getByLabel('Was war das Problem?').fill('Audio QA diagnosis')
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
    if (process.env.A04_QA_WAIT_BEFORE_REPLAY_MS)
      await page.waitForTimeout(Number(process.env.A04_QA_WAIT_BEFORE_REPLAY_MS))
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
    await expect(page.getByRole('heading', { name: 'Lautes Denken' })).toBeVisible({
      timeout: 65000,
    })
    const replayResponse = await page.evaluate(async (id) => {
      const { participantApi } = await import('/src/api/participant.ts')
      return participantApi.getVideoReplay(id)
    }, videos[index].id)
    if (replayResponse.source !== 'screen') {
      await page.waitForTimeout(7000)
      const later = await page.evaluate(
        async (id) => (await import('/src/api/participant.ts')).participantApi.getVideoReplay(id),
        videos[index].id,
      )
      const screens = await api(`/admin/screen-recordings?participant_id=${participantId}`, {
        token: adminToken,
      })
      await writeFile(
        path.join(output, 'replay-race.json'),
        JSON.stringify(
          {
            initial: replayResponse,
            later,
            screens,
            displayedUrl: await page.locator('.replay__video').getAttribute('src'),
          },
          null,
          2,
        ),
      )
    }
    assert.equal(replayResponse.source, 'screen', 'think-aloud selects the actual screen recording')
    assert.equal(replayResponse.recorder, 'bridge')
    assert(replayResponse.plotted_points > 0, 'actual mock gaze reaches backend replay')
    assert.equal(replayResponse.audio_status, index === 1 ? 'failed' : 'captured')
    if (index === 1) await expect(page.locator('.think-aloud > [role="status"]')).toBeVisible()
    else await expect(page.locator('.think-aloud > [role="status"]')).toHaveCount(0)
    let target = Math.min(2, replayResponse.duration_ms / 1000 / 2)
    if (index === 0) {
      const notes = await page.evaluate(
        async (id) => (await import('/src/api/participant.ts')).participantApi.getVideoNotes(id),
        videos[index].id,
      )
      const note = notes.find((note) => note.text === 'Audio QA note at the pause')
      assert(note && note.client_ts, 'the note reached storage with its wall-clock anchor')
      target = (note.client_ts - replayResponse.epoch_ms) / 1000 + 0.15
    }
    await page.locator('.replay__video').evaluate(async (node, time) => {
      if (node.readyState < 2)
        await new Promise((resolve) => node.addEventListener('loadeddata', resolve, { once: true }))
      const done = new Promise((resolve) =>
        node.addEventListener('seeked', resolve, { once: true }),
      )
      node.currentTime = time
      await done
    }, target)
    await expect(page.locator('.gaze-dot')).toHaveCSS('opacity', '1')
    if (index === 0)
      await expect(page.locator('.replay__caption')).toHaveText('Audio QA note at the pause')
    await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).uncheck()
    await expect(page.locator('.gaze-dot')).toHaveCSS('opacity', '0')
    await page.getByRole('checkbox', { name: 'Blickpunkt anzeigen' }).check()
    await expect(page.locator('.gaze-dot')).toHaveCSS('opacity', '1')
    await page.screenshot({ path: path.join(output, `replay-${index + 1}.png`), fullPage: true })
    const url = new URL(replayResponse.video_url, apiOrigin).href
    const response = await fetch(url)
    assert(response.ok)
    const filename = path.join(output, `case-${index + 1}.mp4`)
    await writeFile(filename, Buffer.from(await response.arrayBuffer()))
    const probe = JSON.parse(
      execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', filename], {
        encoding: 'utf8',
      }),
    )
    const audio = probe.streams.find((stream) => stream.codec_type === 'audio')
    if (index !== 1) assert.equal(audio?.codec_name, 'aac')
    console.log(`Completed native case ${index + 1}: ${replayResponse.audio_status}`)
    captures.push({ case: index + 1, filename, replay: replayResponse, probe })
    await page.getByRole('button', { name: 'Weiter', exact: true }).click()
  }
  await page.getByRole('button', { name: /abgeschlossen/ }).click()
  await expect(page.getByRole('heading', { name: 'Vielen Dank!' })).toBeVisible()
  const mediaEvents = await page.evaluate(() => window.qaMediaEvents)
  assert.equal(await page.evaluate(() => window.qaMicRequests), 0)
  const playheadSamples = await page.evaluate(() => window.qaPlayheadSamples)
  const samples = playheadSamples.filter(
    (sample) => sample.case === 3 && !sample.paused && !sample.ended && !sample.seeking,
  )
  let longest = null
  for (let first = 0; first < samples.length; first++) {
    let last = first
    while (
      last + 1 < samples.length &&
      samples[last + 1].time - samples[first].time < 0.03 &&
      samples[last + 1].wall - samples[last].wall < 350
    )
      last++
    if (
      samples[last].wall - samples[first].wall >
      (longest ? longest.end.wall - longest.start.wall : 0)
    )
      longest = { start: samples[first], end: samples[last] }
  }
  assert(
    longest && longest.end.wall - longest.start.wall > 500,
    'real stalled HTTP response stopped the unpaused media clock',
  )
  const stalled = longest.start,
    resumed = longest.end
  const pcmResult = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      captures[2].filename,
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
  const start = (stalled.wall - captures[2].replay.epoch_ms) / 1000 + 0.25
  const end = (resumed.wall - captures[2].replay.epoch_ms) / 1000 - 0.15
  const slice = pcm.slice(Math.round(start * 48000), Math.round(end * 48000))
  const bufferingRms = Math.sqrt(
    slice.reduce((sum, value) => sum + value * value, 0) / slice.length,
  )
  assert(bufferingRms < 0.004, 'real network buffering is silent in the encoded replay')
  console.log(
    `Verified ${resumed.wall - stalled.wall}ms network buffering silence (RMS ${bufferingRms})`,
  )
  const admin = await context.newPage()
  await admin.goto(`${origin}/admin/login`)
  await admin.getByLabel('E-Mail').fill(process.env.A04_QA_EMAIL ?? 'e2e@a04.test')
  await admin.getByLabel('Passwort').fill(process.env.A04_QA_PASSWORD ?? 'e2e-password-1234')
  await admin.getByRole('button', { name: 'Anmelden', exact: true }).click()
  await admin.waitForURL((url) => !url.pathname.endsWith('/login'))
  await admin.goto(`${origin}/admin/gaze`)
  const caseRow = admin
    .getByRole('row')
    .filter({ hasText: participantId })
    .filter({ hasText: 'Audio QA 1' })
    .filter({ hasNotText: /Diagnose|Nach dem Fall/ })
    .filter({ has: admin.getByRole('button', { name: 'Replay', exact: true }) })
    .first()
  await caseRow.getByRole('button', { name: 'Replay', exact: true }).click()
  await expect(admin.locator('.replay__video')).toBeVisible()
  await admin.locator('.replay__video').evaluate(async (video) => {
    await video.play()
  })
  await admin.waitForFunction(() => document.querySelector('.replay__video').currentTime > 0.4)
  await expect(admin.locator('.gaze-dot')).toHaveCSS('opacity', '1')
  const downloadRow = admin
    .getByRole('row')
    .filter({ hasText: participantId })
    .filter({ hasText: 'Audio QA 1' })
    .filter({
      has: admin.getByRole('button', { name: 'Bildschirmaufnahme herunterladen', exact: true }),
    })
    .first()
  const downloaded = admin.waitForEvent('download')
  await downloadRow
    .getByRole('button', { name: 'Bildschirmaufnahme herunterladen', exact: true })
    .click()
  const downloadedPath = path.join(output, 'admin-native-download.mp4')
  await (await downloaded).saveAs(downloadedPath)
  assert(
    (await readFile(downloadedPath)).equals(await readFile(captures[0].filename)),
    'native download is the identical synchronized replay file',
  )
  const downloadProbe = JSON.parse(
    execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', downloadedPath], {
      encoding: 'utf8',
    }),
  )
  assert(
    downloadProbe.streams.some(
      (stream) => stream.codec_type === 'audio' && stream.codec_name === 'aac',
    ),
  )
  await admin.screenshot({ path: path.join(output, 'admin-replay-download.png'), fullPage: true })
  assert.equal(failures.length, 0, failures.join('\n'))
  const report = {
    diagnosticWaitBeforeReplayMs: Number(process.env.A04_QA_WAIT_BEFORE_REPLAY_MS ?? 0),
    status: 'passed',
    studyId: study.id,
    participantId,
    videoIds: videos.map((video) => video.id),
    captures,
    mediaEvents,
    playheadSamples,
    mediaRequests,
    buffering: { stalled, resumed, start, end, rms: bufferingRms },
    downloadProbe,
    browser: await browser.version(),
    limitations: [
      'Tobii samples and ffmpeg display source are synthetic. Browser UI, CORS policy, HTTP stall, media decoding, app lifecycle, database/storage, replay and native download are real.',
    ],
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    JSON.stringify(
      {
        status: report.status,
        output,
        studyId: study.id,
        participantId,
        audioStatuses: captures.map((c) => c.replay.audio_status),
        gazePoints: captures.map((c) => c.replay.plotted_points),
        bufferingMs: resumed.wall - stalled.wall,
        bufferingRms,
      },
      null,
      2,
    ),
  )
} finally {
  clearTimeout(timer)
  if (browser) {
    const last = browser.contexts()[0]?.pages()[0]
    if (last && !last.isClosed()) {
      await last
        .screenshot({ path: path.join(output, 'last-screen.png'), fullPage: true })
        .catch(() => {})
      await writeFile(
        path.join(output, 'last-screen.txt'),
        await last
          .locator('body')
          .innerText()
          .catch(() => ''),
      )
    }
    if (last && !last.isClosed())
      await writeFile(
        path.join(output, 'browser-events.json'),
        JSON.stringify(
          await last
            .evaluate(() => ({
              media: window.qaMediaEvents,
              playhead: window.qaPlayheadSamples,
              recorders: window.qaRecorderEvents,
              sockets: window.qaSocketMessages,
            }))
            .catch(() => ({})),
          null,
          2,
        ),
      )
    await browser.close()
  }
  bridge.kill('SIGINT')
  vite.kill('SIGTERM')
  media.close()
  await writeFile(path.join(output, 'bridge.log'), logs.bridge)
  await writeFile(path.join(output, 'vite.log'), logs.vite)
  await writeFile(
    path.join(output, 'partial.json'),
    JSON.stringify(
      {
        studyId: study.id,
        participantId,
        videoIds: videos.map((video) => video.id),
        captures,
        failures,
        mediaRequests,
      },
      null,
      2,
    ),
  )
}
