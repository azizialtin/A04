import { afterEach, beforeEach, expect, test, vi } from 'vitest'

let level = 0
class Track extends EventTarget {
  readyState = 'live'
  enabled = true
  muted = false
}
class Context extends EventTarget {
  static last: Context
  state = 'suspended'
  destination = {}
  track = new Track()
  constructor() {
    super()
    Context.last = this
  }
  async close() {
    this.state = 'closed'
  }
  async resume() {
    this.state = 'running'
  }
  createMediaStreamDestination() {
    return { stream: { getAudioTracks: () => [this.track] } }
  }
  createAnalyser() {
    return {
      fftSize: 2048,
      connect() {},
      getFloatTimeDomainData: (samples: Float32Array) => samples.fill(level),
    }
  }
  createConstantSource() {
    return { offset: { value: 0 }, connect() {}, start() {} }
  }
  createMediaElementSource() {
    return { connect() {}, disconnect() {} }
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  level = 0
  vi.stubGlobal('AudioContext', Context)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

test('does not call an all-silent track captured merely because it is live', async () => {
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const capture = module.beginStimulusAudio()
  vi.advanceTimersByTime(6000)
  expect(capture.finish()).toMatchObject({ audio_status: 'silent' })
})

test('requires a running clock at start so a delayed resume cannot erase initial silence unnoticed', async () => {
  const module = await import('./stimulusAudio')
  const capture = module.beginStimulusAudio()
  await module.prepareStimulusAudio()
  level = 0.2
  vi.advanceTimersByTime(100)
  expect(capture.finish()).toMatchObject({
    audio_status: 'failed',
    audio_error: expect.stringContaining('recording start'),
  })
})

test('marks a mid-case interruption failed even after recording audible sound', async () => {
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const capture = module.beginStimulusAudio()
  level = 0.2
  vi.advanceTimersByTime(100)
  expect(capture.snapshot().audio_status).toBe('captured')
  Context.last.state = 'suspended'
  Context.last.dispatchEvent(new Event('statechange'))
  expect(capture.finish().audio_status).toBe('failed')
  expect(module.audioWarning()).toBe('failed')
})

test('surfaces ended tracks and source failures rather than claiming successful audio', async () => {
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const capture = module.beginStimulusAudio()
  Context.last.track.dispatchEvent(new Event('ended'))
  expect(capture.finish()).toMatchObject({
    audio_status: 'failed',
    audio_error: expect.stringContaining('ended'),
  })
  const next = module.beginStimulusAudio()
  module.failStimulusAudio('Stimulus media was blocked by CORS')
  expect(next.finish()).toEqual({
    audio_status: 'failed',
    audio_error: 'Stimulus media was blocked by CORS',
  })
})

test('retains an early source failure for a late recorder, then clears it for the next case', async () => {
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  module.failStimulusAudio('CORS source failure before recorder started')
  const failed = module.beginStimulusAudio()
  expect(failed.finish()).toMatchObject({
    audio_status: 'failed',
    audio_error: 'CORS source failure before recorder started',
  })
  expect(module.audioWarning()).toBe('failed')
  module.resetStimulusAudioSource()
  const next = module.beginStimulusAudio()
  expect(next.finish().audio_status).toBe('silent')
  expect(module.audioWarning()).toBeNull()
})

test('unsupported Web Audio returns an explicit unavailable result', async () => {
  vi.stubGlobal('AudioContext', undefined)
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const capture = module.beginStimulusAudio()
  expect(capture.stream).toBeNull()
  expect(capture.finish().audio_status).toBe('unavailable')
  expect(module.audioWarning()).toBe('unavailable')
})

test('a partial graph failure is discarded so the next preparation can recover', async () => {
  vi.spyOn(Context.prototype, 'createConstantSource').mockImplementationOnce(() => {
    throw new Error('device unavailable')
  })
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const failedContext = Context.last
  expect(failedContext.state).toBe('closed')
  await module.prepareStimulusAudio()
  expect(Context.last).not.toBe(failedContext)
  expect(Context.last.state).toBe('running')
  const capture = module.beginStimulusAudio()
  expect(capture.finish().audio_status).toBe('silent')
})

test.each(['mute', 'disabled'])(
  'an interrupted audio track (%s) cannot be reported as captured',
  async (kind) => {
    const module = await import('./stimulusAudio')
    await module.prepareStimulusAudio()
    const capture = module.beginStimulusAudio()
    level = 0.2
    vi.advanceTimersByTime(100)
    expect(capture.snapshot().audio_status).toBe('captured')
    if (kind === 'mute') Context.last.track.dispatchEvent(new Event('mute'))
    else {
      Context.last.track.enabled = false
      vi.advanceTimersByTime(100)
    }
    expect(capture.finish().audio_status).toBe('failed')
  },
)

test('a previous case cannot borrow audio or overwrite warnings from the next case', async () => {
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const previous = module.beginStimulusAudio()
  module.resetStimulusAudioSource()
  const next = module.beginStimulusAudio()
  level = 0.2
  vi.advanceTimersByTime(100)
  expect(previous.snapshot().audio_status).toBe('silent')
  expect(next.snapshot().audio_status).toBe('captured')
  previous.fail('Late upload failure from the previous case')
  expect(module.audioWarning()).toBeNull()
  module.failStimulusAudio('Current source failed')
  expect(next.finish().audio_error).toBe('Current source failed')
  expect(previous.finish().audio_error).toBe('Late upload failure from the previous case')
})

test('closing an audio context recovers native playback and creates a fresh graph for the next case', async () => {
  const module = await import('./stimulusAudio')
  await module.prepareStimulusAudio()
  const fallback = vi.fn()
  const disconnect = module.connectStimulusAudio(document.createElement('video'), fallback)
  const prior = Context.last
  prior.state = 'closed'
  prior.dispatchEvent(new Event('statechange'))
  expect(fallback).toHaveBeenCalledOnce()
  disconnect()
  module.resetStimulusAudioSource()
  await module.prepareStimulusAudio()
  expect(Context.last).not.toBe(prior)
  expect(module.beginStimulusAudio().finish().audio_status).toBe('silent')
})
