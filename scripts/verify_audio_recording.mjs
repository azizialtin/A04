/** Independently verify an existing harness capture through actual HTTP range playback.
 * Usage: node scripts/verify_audio_recording.mjs /path/to/evidence-directory
 * Avoids retaining/re-copying long recording Blobs while checking the saved artifact.
 */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { readFile, writeFile, stat } from 'node:fs/promises'
import { execFileSync, spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(path.join(root, 'frontend/package.json'))
const { chromium } = require('@playwright/test')
const folder = path.resolve(process.argv[2])
const capture = JSON.parse(await readFile(path.join(folder, 'capture.json'), 'utf8'))
const file = path.join(
  folder,
  capture.contentType === 'video/mp4' ? 'recording.mp4' : 'recording.webm',
)
const size = (await stat(file)).size
const probe = JSON.parse(
  execFileSync('ffprobe', ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], {
    encoding: 'utf8',
  }),
)
assert(probe.streams.some((stream) => stream.codec_type === 'audio'))
const decoded = spawnSync(
  'ffmpeg',
  ['-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '48000', '-f', 'f32le', 'pipe:1'],
  { maxBuffer: Math.max(20000000, capture.meta.duration_ms * 200) },
)
assert.equal(decoded.status, 0, decoded.stderr.toString())
const pcm = new Float32Array(
  decoded.stdout.buffer,
  decoded.stdout.byteOffset,
  decoded.stdout.length / 4,
)
const times = Object.fromEntries(
  capture.events.map((event) => [event.name, (event.wall - capture.meta.epoch_ms) / 1000]),
)
const measurements = []
function measure(name, start, end, expectedHz) {
  const values = pcm.subarray(Math.round(start * 48000), Math.round(end * 48000))
  assert(values.length > 1000)
  let square = 0
  const power = { 440: [0, 0], 880: [0, 0], 1500: [0, 0] }
  for (let i = 0; i < values.length; i++) {
    const value = values[i]
    square += value * value
    for (const [frequency, sum] of Object.entries(power)) {
      const phase = (2 * Math.PI * Number(frequency) * i) / 48000
      sum[0] += value * Math.cos(phase)
      sum[1] += value * Math.sin(phase)
    }
  }
  const rms = Math.sqrt(square / values.length)
  const amplitudes = Object.fromEntries(
    Object.entries(power).map(([hz, value]) => [hz, Math.hypot(...value) / values.length]),
  )
  assert(amplitudes[1500] < 0.001, `${name}: unrelated source excluded`)
  if (!expectedHz) assert(rms < 0.004, `${name}: expected silence, RMS ${rms}`)
  else {
    assert(rms > 0.015)
    assert(
      amplitudes[expectedHz] > amplitudes[expectedHz === 440 ? 880 : 440] * 8,
      `${name}: correct passage`,
    )
  }
  const result = { name, start, end, expectedHz, rms, amplitudes }
  measurements.push(result)
  return result
}
measure('initial delay', 0.2, times.first_play - 0.2, 0)
const loud = measure('first passage', times.first_play + 0.2, times.pause - 0.2, 440)
measure('paused notes', times.pause + 0.2, times.repeat - 0.2, 0)
measure('repeated passage', times.repeat + 0.2, times.forward_seek - 0.2, 440)
measure('forward seek', times.forward_seek + 0.15, times.quiet - 0.15, 880)
const quiet = measure('volume change', times.quiet + 0.1, times.muted - 0.1, 880)
assert(quiet.rms / loud.rms > 0.18 && quiet.rms / loud.rms < 0.32)
measure('muted', times.muted + 0.1, times.unmuted_rewind - 0.1, 0)
measure('unmuted rewind', times.unmuted_rewind + 0.2, times.ended - 0.2, 880)
measure('notes after end', times.ended + 0.2, times.end_notes - 0.2, 0)
const cycles = capture.events.filter((event) => /^soak_\d+_play$/.test(event.name))
const drift = []
for (let index = 0; index < cycles.length; index += 10) {
  const event = cycles[index]
  const expected = (event.wall - capture.meta.epoch_ms) / 1000
  measure(event.name, expected + 0.25, expected + 0.65, 440)
  measure(event.name + '_pause', expected + 1.45, expected + 1.75, 0)
  let onset
  for (let offset = -0.25; offset < 0.25; offset += 0.01) {
    const start = Math.round((expected + offset) * 48000)
    let square = 0
    for (let i = start; i < start + 480; i++) square += pcm[i] * pcm[i]
    if (Math.sqrt(square / 480) > 0.02) {
      onset = expected + offset
      break
    }
  }
  assert(onset !== undefined, event.name + ' onset')
  drift.push({ cycle: index, expected, measured: onset, offset: onset - expected })
}
assert(drift.length > 1)
assert(Math.abs(drift.at(-1).offset - drift[0].offset) < 0.15, 'less than150ms additional drift')
assert(capture.meta.duration_ms >= 600000, 'at least10minutes captured')
const requests = []
const server = createServer((req, res) => {
  if (req.url !== '/recording') {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(
      '<button id="enable">Enable sound</button><video controls width="640" src="/recording"></video>',
    )
    return
  }
  const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range ?? '')
  const start = range ? Number(range[1]) : 0
  const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1
  requests.push({ start, end })
  res.writeHead(range ? 206 : 200, {
    'Content-Type': capture.contentType,
    'Content-Length': String(end - start + 1),
    'Accept-Ranges': 'bytes',
    ...(range ? { 'Content-Range': `bytes ${start}-${end}/${size}` } : {}),
  })
  createReadStream(file, { start, end }).pipe(res)
})
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
const browser = await chromium.launch({
  headless: true,
  channel: process.env.A04_BROWSER_CHANNEL ?? 'chrome',
})
const diagnostics = []
let complete = false
try {
  const page = await browser.newPage()
  page.on('crash', () => diagnostics.push('page crashed'))
  page.on('pageerror', (error) => diagnostics.push(String(error)))
  await page.goto(`http://127.0.0.1:${server.address().port}`)
  await page.waitForFunction(() => document.querySelector('video').readyState >= 2)
  await page.evaluate(() => {
    const audio = new AudioContext()
    const analyser = audio.createAnalyser()
    analyser.fftSize = 4096
    audio.createMediaElementSource(document.querySelector('video')).connect(analyser)
    analyser.connect(audio.destination)
    window.qaAudio = { audio, analyser }
    document.querySelector('#enable').onclick = () => audio.resume()
  })
  await page.click('#enable')
  const lastPlay = (cycles.at(-1).wall - capture.meta.epoch_ms) / 1000
  const firstRepeatMedia = capture.events.find((event) => event.name === 'repeat').media
  const checks = [
    { name: 'beginning', time: 0.1, hz: 0, source: 0 },
    {
      name: 'pause',
      time: times.pause + 0.4,
      hz: 0,
      source: capture.events.find((event) => event.name === 'pause').media,
    },
    { name: 'repeat', time: times.repeat + 0.3, hz: 440, source: firstRepeatMedia + 0.3 },
    { name: 'forward', time: times.forward_seek + 0.2, hz: 880 },
    {
      name: 'end of stimulus',
      time: times.ended + 0.4,
      hz: 0,
      source: capture.events.find((event) => event.name === 'ended').media,
    },
    { name: 'last soak passage', time: lastPlay + 0.3, hz: 440, source: 0.3 },
    { name: 'last soak silence', time: lastPlay + 1.5, hz: 0, source: 1.2 },
  ]
  const playback = []
  for (const check of checks) {
    playback.push(
      await page.evaluate(async (check) => {
        const video = document.querySelector('video')
        const seeked = new Promise((resolve) =>
          video.addEventListener('seeked', resolve, { once: true }),
        )
        video.currentTime = check.time
        await seeked
        const canvas = document.createElement('canvas')
        canvas.width = 640
        canvas.height = 360
        const ctx = canvas.getContext('2d')
        ctx.drawImage(video, 0, 0, 640, 360)
        const pixels = ctx.getImageData(0, 0, 640, 32).data
        let ticks = 0
        for (let bit = 0; bit < 16; bit++)
          if (pixels[(16 * 640 + bit * 40 + 20) * 4] > 128) ticks |= 1 << bit
        await video.play()
        await new Promise((resolve) => setTimeout(resolve, 180))
        const { analyser, audio } = window.qaAudio
        const samples = new Float32Array(analyser.fftSize)
        const bins = new Float32Array(analyser.frequencyBinCount)
        analyser.getFloatTimeDomainData(samples)
        analyser.getFloatFrequencyData(bins)
        let peak = 0
        for (let bin = 1; bin < bins.length; bin++) if (bins[bin] > bins[peak]) peak = bin
        const rms = Math.sqrt(
          samples.reduce((sum, value) => sum + value * value, 0) / samples.length,
        )
        video.pause()
        return {
          ...check,
          currentTime: video.currentTime,
          duration: video.duration,
          sourceTime: ticks / 100,
          rms,
          frequency: (peak * audio.sampleRate) / analyser.fftSize,
        }
      }, check),
    )
  }
  for (const result of playback) {
    if (!result.hz) assert(result.rms < 0.004, result.name + ': silent replay')
    else {
      assert(result.rms > 0.015)
      assert(Math.abs(result.frequency - result.hz) < 30, result.name + ': correct audio')
    }
    if (capture.contentType === 'video/webm' && result.source !== undefined)
      assert(Math.abs(result.sourceTime - result.source) < 0.2, result.name + ': screen aligned')
    assert(Math.abs(result.currentTime - result.time - 0.18) < 0.15, result.name + ': seek aligned')
  }
  await page.screenshot({ path: path.join(folder, 'saved-file-replay.png') })
  assert.equal(diagnostics.length, 0, diagnostics.join('\n'))
  const report = {
    status: 'passed',
    verifiedExistingArtifact: true,
    ...capture,
    probe,
    measurements,
    drift,
    playback,
    requests,
    decoderDiagnostics: decoded.stderr.toString(),
    browser: await browser.version(),
    caveat:
      'Original combined long-run harness page closed during repeated Blob playback after recording. This independent verification streams the same saved file over HTTP ranges like production.',
  }
  await writeFile(path.join(folder, 'report.json'), JSON.stringify(report, null, 2) + '\n')
  complete = true
  console.log(
    JSON.stringify(
      {
        status: 'passed',
        folder,
        durationMs: capture.meta.duration_ms,
        size,
        browser: report.browser,
        driftFirst: drift[0],
        driftLast: drift.at(-1),
        seekChecks: playback.map((result) => result.name),
      },
      null,
      2,
    ),
  )
} finally {
  if (!complete)
    await writeFile(path.join(folder, 'replay-diagnostics.json'), JSON.stringify(diagnostics))
  await browser.close()
  server.close()
}
