import type { AudioCaptureMeta } from '../api/screen'

let context: AudioContext | null = null
let destination: MediaStreamAudioDestinationNode | null = null
let analyser: AnalyserNode | null = null
let element: HTMLMediaElement | null = null
let sources = new WeakMap<HTMLMediaElement, MediaElementAudioSourceNode>()
const listeners = new Set<() => void>()
const failures = new Map<(message: string) => void, number>()
let sourceGeneration = 0
let warning: string | null = null
let sourceFailure: string | null = null

export function setAudioWarning(message: string | null): void {
  warning = message
  for (const listener of listeners) listener()
}

export const audioWarning = () => warning
export function subscribeAudioWarning(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function resetStimulusAudioSource(): void {
  sourceGeneration++
  sourceFailure = null
  setAudioWarning(null)
}

export function failStimulusAudio(message: string): void {
  sourceFailure = message
  setAudioWarning('failed')
  for (const [fail, generation] of failures) {
    if (generation === sourceGeneration) fail(message)
  }
}

function graph(): AudioContext {
  if (context && context.state !== 'closed') return context
  const audio = new AudioContext()
  try {
    const output = audio.createMediaStreamDestination()
    const meter = audio.createAnalyser()
    meter.fftSize = 2048
    meter.connect(output)
    // Keep the audio clock running before the video loads and after it ends.
    const silence = audio.createConstantSource()
    silence.offset.value = 0
    silence.connect(output)
    silence.start()
    context = audio
    destination = output
    analyser = meter
    sources = new WeakMap()
    return audio
  } catch (error) {
    void audio.close().catch(() => {})
    throw error
  }
}

/** Call while handling the intro/play click, before awaiting network requests. */
export async function prepareStimulusAudio(): Promise<void> {
  try {
    const audio = graph()
    await audio.resume()
  } catch {
    setAudioWarning('unavailable')
  }
}

/** The same decoded sound goes to the speakers and the recording. */
export function connectStimulusAudio(video: HTMLMediaElement, onFailure?: () => void): () => void {
  let source: MediaElementAudioSourceNode | undefined
  try {
    const audio = graph()
    source = sources.get(video)
    if (!source) {
      source = audio.createMediaElementSource(video)
      sources.set(video, source)
    }
    source.connect(audio.destination)
    source.connect(analyser!)
    element = video
    const contextChanged = () => {
      if (audio.state === 'closed') {
        failStimulusAudio('The audio context closed during stimulus playback')
        onFailure?.()
      }
    }
    audio.addEventListener('statechange', contextChanged)
    return () => {
      audio.removeEventListener('statechange', contextChanged)
      source?.disconnect()
      if (element === video) element = null
    }
  } catch {
    source?.disconnect()
    failStimulusAudio('The case video could not be connected to audio capture')
    onFailure?.()
    return () => {}
  }
}

export interface StimulusCapture {
  stream: MediaStream | null
  snapshot(): AudioCaptureMeta
  fail(error: string): void
  finish(): AudioCaptureMeta
}

export function beginStimulusAudio(): StimulusCapture {
  const generation = sourceGeneration
  let failure: string | null = sourceFailure
  let observed = false
  let quietPlaybackMs = 0
  let available = true
  let stream: MediaStream | null = null
  let audio: AudioContext | null = null
  try {
    audio = graph()
    stream = destination!.stream
  } catch {
    available = false
    failure = 'Web Audio is unavailable in this browser'
  }
  setAudioWarning(available ? (failure ? 'failed' : null) : 'unavailable')
  const fail = (error: string) => {
    failure ??= error
    if (generation === sourceGeneration) setAudioWarning('failed')
  }
  failures.set(fail, generation)
  const track = stream?.getAudioTracks()[0]
  if (available && (!track || track.readyState !== 'live')) fail('No live stimulus audio track')
  if (audio && audio.state !== 'running') fail('The audio clock was not running at recording start')
  const stateChanged = () => {
    if (audio?.state !== 'running') fail('The audio clock stopped during recording')
  }
  const trackEnded = () => fail('The stimulus audio track ended during recording')
  const trackMuted = () => fail('The stimulus audio track was interrupted during recording')
  audio?.addEventListener('statechange', stateChanged)
  track?.addEventListener('ended', trackEnded)
  track?.addEventListener('mute', trackMuted)
  const samples = new Float32Array(analyser?.fftSize ?? 2048)
  const timer = window.setInterval(() => {
    if (track?.enabled === false || track?.muted) trackMuted()
    if (!analyser || failure || generation !== sourceGeneration) return
    analyser.getFloatTimeDomainData(samples)
    if (samples.some((sample) => Math.abs(sample) > 0.0001)) {
      observed = true
      quietPlaybackMs = 0
      if (warning === 'silent') setAudioWarning(null)
    } else if (
      element &&
      !element.paused &&
      !element.ended &&
      !element.muted &&
      element.volume > 0
    ) {
      quietPlaybackMs += 100
      if (quietPlaybackMs >= 5000 && !observed) setAudioWarning('silent')
    }
  }, 100)
  const snapshot = (): AudioCaptureMeta => ({
    audio_status: !available
      ? 'unavailable'
      : failure
        ? 'failed'
        : observed
          ? 'captured'
          : 'silent',
    audio_error: failure ?? (observed ? null : 'No audible stimulus signal was detected'),
  })
  return {
    stream,
    snapshot,
    fail,
    finish: () => {
      failures.delete(fail)
      window.clearInterval(timer)
      audio?.removeEventListener('statechange', stateChanged)
      track?.removeEventListener('ended', trackEnded)
      track?.removeEventListener('mute', trackMuted)
      return snapshot()
    },
  }
}
