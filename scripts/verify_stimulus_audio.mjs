/** Real Chromium/MediaRecorder evidence; run: node scripts/verify_stimulus_audio.mjs.
 * Add --literal for the reviewer's 15s/20s/rewind-to-5 example, or --soak-seconds=600.
 * Add --bridge to test the Python bridge; A04_PYTHON selects its interpreter.
 * Requires installed frontend dependencies, Playwright Chromium, ffmpeg and ffprobe.
 * The display picker is replaced with a canvas video track; stimulus decoding,
 * Web Audio, capture, upload formatting, replay seeking and codecs are real.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createServer } from 'node:http'
import { access, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const bridgeMode = process.argv.includes('--bridge')
const literal = process.argv.includes('--literal')
const silentSource = process.argv.includes('--silent-source')
const delayStartHandlerMs = Number(
  process.argv.find((arg) => arg.startsWith('--delay-start-handler-ms='))?.split('=')[1] ?? 0,
)
assert(
  Number.isFinite(delayStartHandlerMs) && delayStartHandlerMs >= 0 && delayStartHandlerMs <= 1000,
)
const soakSeconds = Number(
  process.argv.find((arg) => arg.startsWith('--soak-seconds='))?.split('=')[1] ?? 0,
)
assert(Number.isFinite(soakSeconds) && soakSeconds >= 0 && soakSeconds <= 1800)
const scenario = literal
  ? {
      duration: 20,
      change: 16,
      firstEnd: 15,
      pauseMs: 20000,
      rewind: 5,
      repeatEnd: 15,
      forward: 17,
      quiet: 18,
      muted: 18.6,
      unmute: 19.4,
      finalRewind: 19,
    }
  : {
      duration: 4,
      change: 2,
      firstEnd: 1.2,
      pauseMs: 1100,
      rewind: 0.4,
      repeatEnd: 1.2,
      forward: 2.2,
      quiet: 2.9,
      muted: 3.35,
      unmute: 3.8,
      finalRewind: 3,
    }

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const frontend = path.join(root, 'frontend')
const require = createRequire(path.join(frontend, 'package.json'))
const { chromium } = require('@playwright/test')
const bridgePython =
  process.env.A04_PYTHON ??
  path.join(
    root,
    process.platform === 'win32' ? 'backend/.venv/Scripts/python.exe' : 'backend/.venv/bin/python',
  )
if (bridgeMode) await access(bridgePython)
const output =
  process.env.A04_AUDIO_EVIDENCE_DIR ??
  (await mkdtemp(path.join(os.tmpdir(), 'a04-audio-evidence-')))
await mkdir(output, { recursive: true })
const stimulus = path.join(output, 'stimulus.webm')
execFileSync('ffmpeg', [
  '-y',
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=320x180:rate=30:duration=${scenario.duration}`,
  '-f',
  'lavfi',
  '-i',
  `aevalsrc=0.25*sin(2*PI*if(lt(t\\,${scenario.change})\\,440\\,880)*t):s=48000:d=${scenario.duration}`,
  '-c:v',
  'libvpx',
  '-b:v',
  '200k',
  ...(silentSource ? ['-an'] : ['-c:a', 'libopus']),
  '-shortest',
  stimulus,
])

const reserve = createServer()
await new Promise((resolve) => reserve.listen(0, '127.0.0.1', resolve))
const port = reserve.address().port
await new Promise((resolve) => reserve.close(resolve))
const origin = `http://127.0.0.1:${port}`
const viteModule = path.join(
  path.dirname(require.resolve('vite/package.json')),
  'dist/node/index.js',
)
const serverCode = `import {createServer} from ${JSON.stringify(pathToFileURL(viteModule).href)};
const server = await createServer({root: ${JSON.stringify(frontend)}, configFile: false,
cacheDir: ${JSON.stringify(path.join(output, 'vite-cache'))},
server: {host: '127.0.0.1', port: ${port}, strictPort: true}});
await server.listen(); server.printUrls();`
const vite = spawn(process.execPath, ['--input-type=module', '-e', serverCode], {
  cwd: frontend,
  env: { ...process.env, VITE_API_BASE_URL: '/api' },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let viteLog = ''
vite.stdout.on('data', (chunk) => {
  viteLog += chunk
})
vite.stderr.on('data', (chunk) => {
  viteLog += chunk
})
let browser
let bridge
let bridgeLog = ''
let received
let receiveError
let receiver
let receiverOrigin
let bridgePort
if (bridgeMode) {
  receiver = createServer(async (req, res) => {
    try {
      const pieces = []
      for await (const piece of req) pieces.push(piece)
      const body = Buffer.concat(pieces)
      const form = await new Response(body, {
        headers: { 'Content-Type': req.headers['content-type'] },
      }).formData()
      const file = form.get('file')
      const meta = Object.fromEntries([...form.entries()].filter(([key]) => key !== 'file'))
      for (const key of ['epoch_ms', 'duration_ms', 'width', 'height', 'fps'])
        if (meta[key]) meta[key] = Number(meta[key])
      received = {
        bytes: Buffer.from(await file.arrayBuffer()),
        meta,
        contentType: file.type,
      }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    } catch (error) {
      receiveError = String(error)
      res.writeHead(500)
      res.end(receiveError)
    }
  })
  await new Promise((resolve) => receiver.listen(0, '127.0.0.1', resolve))
  receiverOrigin = `http://127.0.0.1:${receiver.address().port}`
  const wsReserve = createServer()
  await new Promise((resolve) => wsReserve.listen(0, '127.0.0.1', resolve))
  bridgePort = wsReserve.address().port
  await new Promise((resolve) => wsReserve.close(resolve))
  bridge = spawn(
    bridgePython,
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
  bridge.stdout.on('data', (chunk) => {
    bridgeLog += chunk
  })
  bridge.stderr.on('data', (chunk) => {
    bridgeLog += chunk
  })
}
const deadlineTimer = setTimeout(
  () => {
    console.error('Audio integration exceeded its deadline')
    void browser?.close()
    bridge?.kill('SIGINT')
    vite.kill('SIGTERM')
    receiver?.close()
  },
  (soakSeconds + 150) * 1000,
)
deadlineTimer.unref()
try {
  const deadline = Date.now() + 20_000
  while (true) {
    try {
      if ((await fetch(origin)).ok) break
    } catch {
      /* startup */
    }
    assert(Date.now() < deadline, `Vite did not start: ${viteLog}`)
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (bridgeMode) {
    const bridgeDeadline = Date.now() + 15_000
    while (!bridgeLog.includes('listening on')) {
      assert(
        Date.now() < bridgeDeadline && bridge.exitCode === null,
        `Bridge failed to start: ${bridgeLog}`,
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  browser = await chromium.launch({
    headless: true,
    ...(process.env.A04_BROWSER_CHANNEL ? { channel: process.env.A04_BROWSER_CHANNEL } : {}),
  })
  const page = await browser.newPage()
  if (bridgeMode) await page.context().grantPermissions(['local-network-access'], { origin })
  const errors = []
  page.on('pageerror', (error) => errors.push(String(error)))
  await page.route(`${origin}/audio-harness`, (route) =>
    route.fulfill({
      contentType: 'text/html',
      body: '<button id="prepare">Prepare audio</button><video id="stimulus" crossorigin="anonymous" preload="auto"></video><canvas id="screen" width="640" height="360"></canvas>',
    }),
  )
  const sourceBytes = await readFile(stimulus)
  await page.route(`${origin}/stimulus.webm`, (route) => {
    const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? '')
    const start = range ? Number(range[1]) : 0
    const end = range?.[2] ? Number(range[2]) : sourceBytes.length - 1
    return route.fulfill({
      status: range ? 206 : 200,
      contentType: 'video/webm',
      headers: {
        'Accept-Ranges': 'bytes',
        ...(range ? { 'Content-Range': `bytes ${start}-${end}/${sourceBytes.length}` } : {}),
      },
      body: sourceBytes.subarray(start, end + 1),
    })
  })
  const uploads = []
  await page.route(`${origin}/api/**`, async (route) => {
    const req = route.request()
    if (req.url().endsWith('/upload-url')) {
      await route.fulfill({ json: { mode: 'local', upload_url: null } })
    } else if (req.url().endsWith('/upload')) {
      uploads.push({
        headers: req.headers(),
        hasAudioStatus: req.postDataBuffer().includes(Buffer.from('name=\"audio_status\"')),
      })
      await route.fulfill({ json: { ok: true } })
    } else if (req.url().endsWith('/screen/recordings')) {
      await route.fulfill({
        json: { recording_id: 17, upload_token: 'test-upload' },
      })
    } else {
      await route.fulfill({
        status: 500,
        json: { error: 'unexpected API request', url: req.url() },
      })
    }
  })
  await page.goto(`${origin}/audio-harness`)
  await page.evaluate(
    async ({
      bridgeMode,
      bridgePort,
      receiverOrigin,
      scenario,
      soakSeconds,
      delayStartHandlerMs,
    }) => {
      navigator.mediaDevices.getUserMedia = () => {
        throw new Error('Microphone/camera access is forbidden in this test')
      }
      window.recorderTiming = []
      window.audioSidecar = []
      const NativeRecorder = window.MediaRecorder
      window.MediaRecorder = class extends NativeRecorder {
        constructor(stream, options) {
          super(stream, options)
          this.addEventListener('start', (event) =>
            window.recorderTiming.push({
              kind: 'start-event',
              wall: Date.now(),
              eventTimestamp: event.timeStamp,
              performanceOrigin: performance.timeOrigin,
              performanceNow: performance.now(),
              mimeType: options?.mimeType,
            }),
          )
          if (delayStartHandlerMs)
            this.addEventListener('start', () => {
              const deadline = performance.now() + delayStartHandlerMs
              while (performance.now() < deadline) {
                /* deliberate dispatch-delay regression */
              }
            })
          if (bridgeMode && options?.mimeType?.startsWith('audio/')) {
            window.audioSidecarType = options.mimeType
            this.addEventListener('dataavailable', ({ data }) => {
              if (data.size) window.audioSidecar.push(data)
            })
          }
        }
        start(...args) {
          window.recorderTiming.push({
            kind: 'start-call',
            wall: Date.now(),
            performanceOrigin: performance.timeOrigin,
            performanceNow: performance.now(),
          })
          return super.start(...args)
        }
      }
      const audio = await import('/src/lib/stimulusAudio.ts')
      const capture = await import('/src/lib/screenCapture.ts')
      const { startBridgeAudio } = await import('/src/lib/bridgeAudio.ts')
      const { screenApi } = await import('/src/api/screen.ts')
      const video = document.querySelector('#stimulus')
      // Ref attachment occurs before the gesture, as on the case screen.
      const disconnect = audio.connectStimulusAudio(video)
      video.src = '/stimulus.webm'
      await new Promise((resolve, reject) => {
        video.addEventListener('loadeddata', resolve, { once: true })
        video.addEventListener('error', () => reject(new Error('stimulus failed')), { once: true })
      })
      const originalDeliver = screenApi.deliver
      screenApi.deliver = async (...args) => {
        window.delivered = { blob: args[2], meta: args[3] }
        return originalDeliver(...args)
      }
      document.querySelector('#prepare').onclick = async () => {
        await audio.prepareStimulusAudio()
        window.ready = true
      }
      window.harness = {
        audio,
        capture,
        video,
        disconnect,
        startBridgeAudio,
        bridgeMode,
        bridgePort,
        receiverOrigin,
        scenario,
        soakSeconds,
      }
    },
    { bridgeMode, bridgePort, receiverOrigin, scenario, soakSeconds, delayStartHandlerMs },
  )
  await page.click('#prepare')
  await page.waitForFunction(() => window.ready === true)
  const result = await page.evaluate(async () => {
    const {
      capture,
      video,
      disconnect,
      startBridgeAudio,
      bridgeMode,
      bridgePort,
      receiverOrigin,
      scenario,
      soakSeconds,
    } = window.harness
    const canvas = document.querySelector('#screen')
    const context = canvas.getContext('2d')
    const events = []
    const startWall = Date.now()
    const note = (name) => events.push({ name, wall: Date.now(), media: video.currentTime })
    let painting = true
    const paint = () => {
      context.fillStyle = '#111'
      context.fillRect(0, 0, 640, 360)
      context.drawImage(video, 0, 40, 640, 320)
      // Encode source playhead into sixteen robust black/white frame markers.
      const tick = Math.round(video.currentTime * 100)
      for (let bit = 0; bit < 16; bit++) {
        context.fillStyle = tick & (1 << bit) ? '#fff' : '#000'
        context.fillRect(bit * 40, 0, 40, 32)
      }
      if (painting) requestAnimationFrame(paint)
    }
    paint()
    const stream = canvas.captureStream(30)
    // A display picker may return unrelated audio. The recorder must discard it.
    const unrelated = new AudioContext()
    await unrelated.resume()
    const unrelatedDestination = unrelated.createMediaStreamDestination()
    const unrelatedTone = unrelated.createOscillator()
    unrelatedTone.frequency.value = 1500
    unrelatedTone.connect(unrelatedDestination)
    unrelatedTone.start()
    stream.addTrack(unrelatedDestination.stream.getAudioTracks()[0])
    let recording
    const bridgeErrors = []
    if (bridgeMode) {
      const ws = new WebSocket(`ws://127.0.0.1:${bridgePort}`)
      let started, stopped
      const screenStarted = new Promise((resolve) => {
        started = resolve
      })
      const screenStopped = new Promise((resolve) => {
        stopped = resolve
      })
      const ready = new Promise((resolve, reject) => {
        ws.onerror = () => reject(new Error('Bridge connection failed'))
        ws.onmessage = (event) => {
          const message = JSON.parse(event.data)
          if (message.type === 'status') resolve(message)
          if (message.type === 'screen_recording_started') started(message)
          if (message.type === 'screen_recording_stopped') stopped(message)
          if (message.type === 'stimulus_audio_error') bridgeErrors.push(message.error)
        }
      })
      const status = await ready
      if (!status.stimulus_audio || !status.screen_recording)
        throw new Error('Bridge lacks audio/screen capabilities')
      const audio = startBridgeAudio(ws)
      ws.send(
        JSON.stringify({
          type: 'start_screen_recording',
          upload_url: `${receiverOrigin}/upload`,
          token: 'integration-test',
        }),
      )
      const ack = await screenStarted
      if (!ack.ok) throw new Error(ack.error)
      audio.beginSending()
      recording = {
        stop: async () => {
          await audio.stop()
          ws.send(JSON.stringify({ type: 'stop_screen_recording' }))
          const stopped = await screenStopped
          ws.close()
          if (!stopped.ok) throw new Error(stopped.error)
        },
      }
    } else {
      recording = capture.startBrowserRecording(31, stream)
    }
    if (!recording) throw new Error('browser capture did not start')
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const until = async (time) => {
      const deadline = performance.now() + Math.max(5000, (time - video.currentTime + 5) * 1000)
      while (video.currentTime < time) {
        if (performance.now() > deadline)
          throw new Error(`playback stalled at ${video.currentTime}`)
        await wait(20)
      }
    }
    const seek = async (time) => {
      const seeked = new Promise((resolve) =>
        video.addEventListener('seeked', resolve, { once: true }),
      )
      video.currentTime = time
      await seeked
      if (Math.abs(video.currentTime - time) > 0.1)
        throw new Error(`fixture seek failed: ${time} -> ${video.currentTime}`)
    }
    note('delay')
    await wait(1000)
    await video.play()
    note('first_play')
    await until(scenario.firstEnd)
    video.pause()
    note('pause')
    await wait(scenario.pauseMs)
    await seek(scenario.rewind)
    await video.play()
    note('repeat')
    await until(scenario.repeatEnd)
    await seek(scenario.forward)
    note('forward_seek')
    await until(scenario.quiet)
    video.volume = 0.25
    note('quiet')
    await until(scenario.muted)
    video.muted = true
    note('muted')
    await until(scenario.unmute)
    video.muted = false
    video.volume = 1
    await seek(scenario.finalRewind)
    note('unmuted_rewind')
    await new Promise((resolve) => video.addEventListener('ended', resolve, { once: true }))
    note('ended')
    await wait(1000)
    note('end_notes')
    let cycle = 0
    while (Date.now() - startWall < soakSeconds * 1000) {
      await seek(0)
      await video.play()
      note(`soak_${cycle}_play`)
      await until(1.2)
      video.pause()
      note(`soak_${cycle}_pause`)
      await wait(800)
      cycle++
    }
    note('stop')
    await recording.stop()
    painting = false
    for (const track of stream.getTracks()) track.stop()
    disconnect()
    unrelatedTone.stop()
    await unrelated.close()
    if (bridgeMode)
      return { events, startWall, bridgeErrors, recorderTiming: window.recorderTiming }
    if (!window.delivered) throw new Error('recording was not delivered')
    const { blob, meta } = window.delivered
    return {
      events,
      startWall,
      meta,
      contentType: blob.type,
      recorderTiming: window.recorderTiming,
      warning: window.harness.audio.audioWarning(),
    }
  })
  if (bridgeMode) {
    const uploadDeadline = Date.now() + 30_000
    while (!received) {
      assert(!receiveError, receiveError)
      assert(Date.now() < uploadDeadline, `Bridge upload timed out: ${bridgeLog}`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
    assert.equal(result.bridgeErrors.length, 0, result.bridgeErrors.join('\n'))
    Object.assign(result, {
      meta: received.meta,
      contentType: received.contentType,
    })
    await writeFile(path.join(output, 'bridge.log'), bridgeLog)
    const sidecarDownload = page.waitForEvent('download')
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(
        new Blob(window.audioSidecar, { type: window.audioSidecarType }),
      )
      link.download = 'stimulus-sidecar.webm'
      document.body.append(link)
      link.click()
      link.remove()
    })
    await (await sidecarDownload).saveAs(path.join(output, 'stimulus-sidecar.webm'))
    const checked = spawnSync('ffmpeg', [
      '-v',
      'error',
      '-i',
      path.join(output, 'stimulus-sidecar.webm'),
      '-f',
      'null',
      '-',
    ])
    await writeFile(path.join(output, 'sidecar-decode.txt'), checked.stderr)
    assert.equal(checked.status, 0, 'bridge audio-only source decodes successfully')
  }
  const recordingPath = path.join(
    output,
    result.contentType === 'video/mp4' ? 'recording.mp4' : 'recording.webm',
  )
  if (bridgeMode) await writeFile(recordingPath, received.bytes)
  else {
    const downloaded = page.waitForEvent('download')
    await page.evaluate(() => {
      const link = document.createElement('a')
      link.href = URL.createObjectURL(window.delivered.blob)
      link.download = 'screen-recording.webm'
      document.body.append(link)
      link.click()
      link.remove()
    })
    await (await downloaded).saveAs(recordingPath)
  }
  await writeFile(path.join(output, 'capture.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(`Evidence: ${output}`)
  assert.equal(errors.length, 0, errors.join('\n'))
  if (!bridgeMode) {
    assert.equal(uploads.length, 1, 'exactly one real upload request')
    assert.match(uploads[0].headers['content-type'], /multipart\/form-data/)
    assert(uploads[0].hasAudioStatus, 'audio status travels through multipart upload')
  }
  const probe = JSON.parse(
    execFileSync(
      'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', recordingPath],
      { encoding: 'utf8' },
    ),
  )
  assert(
    probe.streams.some((stream) => stream.codec_type === 'audio'),
    'encoded audio stream',
  )
  assert(
    probe.streams.some((stream) => stream.codec_type === 'video'),
    'encoded video stream',
  )
  if (bridgeMode) {
    const audioDuration = Number(
      probe.streams.find((stream) => stream.codec_type === 'audio').duration,
    )
    const videoDuration = Number(
      probe.streams.find((stream) => stream.codec_type === 'video').duration,
    )
    assert(
      Math.abs(audioDuration - videoDuration) < 0.08,
      'muxed audio covers the complete video track',
    )
  }
  const decoded = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      recordingPath,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '48000',
      '-f',
      'f32le',
      'pipe:1',
    ],
    { maxBuffer: Math.max(20_000_000, (soakSeconds + 100) * 200_000) },
  )
  assert.equal(decoded.status, 0, decoded.stderr.toString())
  const decoderDiagnostics = decoded.stderr.toString().trim()
  const samples = decoded.stdout
  const pcm = new Float32Array(samples.buffer, samples.byteOffset, samples.length / 4)
  const times = Object.fromEntries(
    result.events.map((event) => [event.name, (event.wall - result.meta.epoch_ms) / 1000]),
  )
  const measurements = []
  function measure(name, start, end) {
    const segment = pcm.slice(Math.round(start * 48000), Math.round(end * 48000))
    assert(segment.length > 1000, `${name}: enough audio samples`)
    const rms = Math.sqrt(segment.reduce((sum, value) => sum + value * value, 0) / segment.length)
    const power = (frequency) => {
      let re = 0,
        im = 0
      for (let i = 0; i < segment.length; i++) {
        const phase = (2 * Math.PI * frequency * i) / 48000
        re += segment[i] * Math.cos(phase)
        im += segment[i] * Math.sin(phase)
      }
      return Math.hypot(re, im) / segment.length
    }
    const measured = {
      name,
      start,
      end,
      rms,
      power440: power(440),
      power880: power(880),
      power1500: power(1500),
    }
    measurements.push(measured)
    assert(measured.power1500 < 0.001, `${name}: unrelated display audio was excluded`)
    return measured
  }
  const silence = (name, start, end) =>
    assert(measure(name, start, end).rms < 0.004, `${name}: expected silence`)
  const tone = (name, start, end, frequency) => {
    const m = measure(name, start, end)
    assert(m.rms > 0.015, `${name}: expected audible samples`)
    assert(
      m[`power${frequency}`] > m[`power${frequency === 440 ? 880 : 440}`] * 8,
      `${name}: expected ${frequency} Hz`,
    )
    return m
  }
  if (silentSource) {
    assert.equal(
      result.meta.audio_status,
      'silent',
      'source without soundtrack is identified as silent',
    )
    silence('entire silent source', 0.2, times.end_notes - 0.2)
  } else {
    silence('initial delay', 0.2, times.first_play - 0.2)
    const loud = tone('first passage', times.first_play + 0.2, times.pause - 0.2, 440)
    silence('paused notes', times.pause + 0.2, times.repeat - 0.2)
    tone('repeated passage', times.repeat + 0.2, times.forward_seek - 0.2, 440)
    tone('seeked passage', times.forward_seek + 0.15, times.quiet - 0.15, 880)
    const quiet = tone('volume reduction', times.quiet + 0.1, times.muted - 0.1, 880)
    assert(
      quiet.rms / loud.rms > 0.18 && quiet.rms / loud.rms < 0.32,
      'volume follows the stimulus',
    )
    silence('muted passage', times.muted + 0.1, times.unmuted_rewind - 0.1)
    tone('unmuted rewind', times.unmuted_rewind + 0.2, times.ended - 0.2, 880)
    silence('notes after end', times.ended + 0.2, times.end_notes - 0.2)
  }

  const drift = []
  const soakEvents = result.events.filter((event) => /^soak_\d+_play$/.test(event.name))
  for (let index = 0; index < soakEvents.length; index += 10) {
    const event = soakEvents[index]
    const expected = (event.wall - result.meta.epoch_ms) / 1000
    tone(event.name, expected + 0.25, expected + 0.65, 440)
    silence(event.name.replace('_play', '_silence'), expected + 1.45, expected + 1.75)
    let onset = null
    for (let offset = -0.25; offset < 0.25; offset += 0.01) {
      const start = Math.round((expected + offset) * 48000)
      let square = 0
      for (let i = start; i < start + 480; i++) square += pcm[i] * pcm[i]
      if (Math.sqrt(square / 480) > 0.02) {
        onset = expected + offset
        break
      }
    }
    assert(onset !== null, `${event.name}: audio onset aligned with wall clock`)
    drift.push({ cycle: index, expected, measured: onset, offset: onset - expected })
  }
  if (drift.length > 1)
    assert(
      Math.abs(drift.at(-1).offset - drift[0].offset) < 0.15,
      'less than 150ms additional audio drift during soak',
    )
  if (soakSeconds)
    assert(result.meta.duration_ms >= (soakSeconds - 5) * 1000, 'full soak duration captured')

  // Seek the real browser replay and inspect the recorded source playhead markers.
  const replay = bridgeMode
    ? []
    : await page.evaluate(
        async ({ checks }) => {
          const video = document.createElement('video')
          video.src = URL.createObjectURL(window.delivered.blob)
          document.body.append(video)
          await new Promise((resolve) =>
            video.addEventListener('loadeddata', resolve, { once: true }),
          )
          if (!Number.isFinite(video.duration)) {
            video.currentTime = 1e10
            await new Promise((resolve) =>
              video.addEventListener('seeked', resolve, { once: true }),
            )
          }
          const canvas = document.createElement('canvas')
          canvas.width = 640
          canvas.height = 360
          const ctx = canvas.getContext('2d')
          const results = []
          for (const check of checks) {
            const seeked = new Promise((resolve) =>
              video.addEventListener('seeked', resolve, { once: true }),
            )
            video.currentTime = check.time
            await seeked
            ctx.drawImage(video, 0, 0, 640, 360)
            const pixels = ctx.getImageData(0, 0, 640, 32).data
            let ticks = 0
            for (let bit = 0; bit < 16; bit++)
              if (pixels[(16 * 640 + bit * 40 + 20) * 4] > 128) ticks |= 1 << bit
            results.push({
              ...check,
              actualReplayTime: video.currentTime,
              recordedStimulusTime: ticks / 100,
            })
          }
          return results
        },
        {
          checks: [
            {
              name: 'paused',
              time: times.pause + 0.5,
              expectedSource: result.events.find((event) => event.name === 'pause').media,
            },
            {
              name: 'repeated',
              time: times.repeat + 0.35,
              expectedSource: scenario.rewind + 0.35,
            },
            { name: 'after end', time: times.ended + 0.5, expectedSource: scenario.duration },
          ],
        },
      )
  for (const check of replay) {
    assert(Math.abs(check.actualReplayTime - check.time) < 0.05, `${check.name}: replay seek`)
    assert(
      Math.abs(check.recordedStimulusTime - check.expectedSource) < 0.2,
      `${check.name}: screen/audio time alignment`,
    )
  }
  const replayBytes = await readFile(recordingPath)
  await page.route(`${origin}/captured`, (route) =>
    route.fulfill({ contentType: result.contentType, body: replayBytes }),
  )
  const replayAudio = await page.evaluate(
    async ({ checks }) => {
      const video = document.createElement('video')
      video.src = URL.createObjectURL(await (await fetch('/captured')).blob())
      document.body.append(video)
      await new Promise((resolve) => video.addEventListener('loadeddata', resolve, { once: true }))
      const audio = new AudioContext()
      await audio.resume()
      const analyser = audio.createAnalyser()
      analyser.fftSize = 4096
      analyser.smoothingTimeConstant = 0
      audio.createMediaElementSource(video).connect(analyser)
      analyser.connect(audio.destination)
      const values = new Float32Array(analyser.fftSize)
      const bins = new Float32Array(analyser.frequencyBinCount)
      const results = []
      for (const check of checks) {
        const seeked = new Promise((resolve) =>
          video.addEventListener('seeked', resolve, { once: true }),
        )
        video.currentTime = check.time
        await seeked
        const afterSeek = video.currentTime
        await video.play()
        const startedAt = performance.now()
        const audioStartedAt = audio.currentTime
        const analysisWindow = analyser.fftSize / audio.sampleRate
        // Decoder startup and a JS timer do not advance on the media clock.
        while (
          (video.currentTime - afterSeek < 0.18 ||
            audio.currentTime - audioStartedAt < analysisWindow) &&
          performance.now() - startedAt < 3000
        ) {
          await new Promise((resolve) => setTimeout(resolve, 10))
        }
        analyser.getFloatTimeDomainData(values)
        analyser.getFloatFrequencyData(bins)
        const rms = Math.sqrt(values.reduce((sum, x) => sum + x * x, 0) / values.length)
        let peak = 0
        for (let bin = 1; bin < bins.length; bin++) if (bins[bin] > bins[peak]) peak = bin
        const frequency = (peak * audio.sampleRate) / analyser.fftSize
        results.push({
          ...check,
          afterSeek,
          rms,
          frequency,
          currentTime: video.currentTime,
          elapsedMs: performance.now() - startedAt,
          audioElapsed: audio.currentTime - audioStartedAt,
          analysisWindow,
          readyState: video.readyState,
          audioState: audio.state,
          mediaError: video.error?.message ?? null,
        })
        video.pause()
      }
      await audio.close()
      return results
    },
    {
      checks: [
        {
          name: 'seek into paused interval',
          time: times.pause + 0.35,
          endTime: times.repeat - 0.05,
          frequency: 0,
        },
        {
          name: 'seek into repeated passage',
          time: times.repeat + 0.2,
          endTime: times.forward_seek - 0.05,
          frequency: 440,
        },
        {
          name: 'seek into forward passage',
          time: times.forward_seek + 0.15,
          endTime: times.quiet - 0.05,
          frequency: 880,
        },
        {
          name: 'seek into final notes',
          time: times.ended + 0.35,
          endTime: times.end_notes - 0.05,
          frequency: 0,
        },
      ],
    },
  )
  await writeFile(path.join(output, 'replay-audio.json'), JSON.stringify(replayAudio, null, 2) + '\n')
  for (const [i, check] of replayAudio.entries()) {
    assert(Math.abs(check.afterSeek - check.time) < 0.05, `${check.name}: replay seek position`)
    assert(check.currentTime - check.afterSeek >= 0.18, `${check.name}: replay stalled`)
    assert(check.audioElapsed >= check.analysisWindow, `${check.name}: audio rendering stalled`)
    assert(check.currentTime < check.endTime, `${check.name}: replay left the expected passage`)
    const expected = silentSource ? 0 : [0, 440, 880, 0][i]
    if (expected === 0) assert(check.rms < 0.004, `${check.name}: silent replay`)
    else {
      assert(check.rms > 0.015, `${check.name}: audible replay`)
      assert(Math.abs(check.frequency - expected) < 30, `${check.name}: correct replay passage`)
    }
  }
  const report = {
    ...result,
    mode: bridgeMode ? 'bridge' : 'browser',
    scenario: literal ? 'literal-reviewer-example' : 'short',
    soakSeconds,
    silentSource,
    delayStartHandlerMs,
    drift,
    probe,
    measurements,
    replay,
    replayAudio,
    decoderDiagnostics,
    browser: await browser.version(),
    limitations: [
      'Canvas/test-pattern replaces native display selection; OS permission picker and Windows desktop capture require lab acceptance.',
      'Bridge mode grants local-network-access; production users must allow the site to reach the local bridge.',
      'Synthetic tones establish timing and encoded media behavior, not physical speaker output or Tobii accuracy.',
    ],
  }
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        output,
        browser: report.browser,
        audioStatus: result.meta.audio_status,
        audioCodec: probe.streams.find((stream) => stream.codec_type === 'audio').codec_name,
        checks: measurements.map((item) => item.name),
        replay,
        replayAudio,
        driftSummary: drift.length
          ? { intervals: drift.length, first: drift[0], last: drift.at(-1) }
          : null,
      },
      null,
      2,
    ),
  )
} finally {
  clearTimeout(deadlineTimer)
  await browser?.close()
  vite.kill('SIGTERM')
  if (bridgeMode) {
    await writeFile(path.join(output, 'bridge.log'), bridgeLog)
    console.log(`Bridge log: ${output}\n${bridgeLog}`)
  }
  bridge?.kill('SIGINT')
  receiver?.close()
}
