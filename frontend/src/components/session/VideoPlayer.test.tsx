import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import VideoPlayer from './VideoPlayer'

vi.mock('../../api/participant', () => ({
  participantApi: { getVideoUrl: vi.fn(async () => ({ signed_url: 'https://cdn.test/clip.mp4' })) },
}))
// The lab bridge is not here, and neither hook has anything to say without it.
vi.mock('../../hooks/useGazeCapture', () => ({ useGazeCapture: () => undefined }))
vi.mock('../../hooks/useScreenRecording', () => ({ useScreenRecording: () => undefined }))

const enqueue = vi.fn()
vi.mock('../../lib/outbox', () => ({ enqueue: (...args: unknown[]) => enqueue(...args) }))

/** The events the player queued, in order. */
const fired = () =>
  enqueue.mock.calls.map(([, body]) => (body as { event_type: string }).event_type)

/** jsdom pins `paused` to true on the prototype; the player reads it to decide
 *  which way the button goes, so the test has to be able to move it. */
const setPaused = (video: HTMLVideoElement, value: boolean) =>
  Object.defineProperty(video, 'paused', { value, configurable: true })

let play: ReturnType<typeof vi.spyOn>
let pause: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  enqueue.mockClear()
  // jsdom has no media stack: play() rejects and pause() is a no-op. Spy on
  // both, and drive the element's own events by hand.
  play = vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  pause = vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => vi.restoreAllMocks())

async function mount(props: { onEnded?: () => void } = {}) {
  render(<VideoPlayer videoId={7} {...props} />)
  const video = (await screen.findByLabelText('Fallvideo')) as HTMLVideoElement
  // jsdom leaves both of these on the prototype as constants; the player reads
  // them to size the scrubber and to decide which way the button goes.
  Object.defineProperty(video, 'duration', { value: 120, configurable: true })
  setPaused(video, true)
  await act(async () => {
    fireEvent.loadedMetadata(video)
  })
  return video
}

test('offers only a play/pause button and the position bar', async () => {
  const video = await mount()

  // No native control bar, and so none of what it would have carried with it:
  // volume, playback rate, picture-in-picture, fullscreen.
  expect(video).not.toHaveAttribute('controls')
  expect(video).toHaveAttribute('disablepictureinpicture')

  expect(screen.getByRole('button', { name: 'Abspielen' })).toBeInTheDocument()
  expect(screen.getByRole('slider', { name: 'Videoposition' })).toBeInTheDocument()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

test('the button plays, pauses and logs both', async () => {
  const video = await mount()
  const button = screen.getByRole('button')

  fireEvent.click(button)
  expect(play).toHaveBeenCalled()

  await act(async () => {
    setPaused(video, false)
    fireEvent.play(video)
  })
  expect(fired()).toEqual(['video_started'])
  // The label follows the state, so the control always says what it will do.
  expect(screen.getByRole('button', { name: 'Pause' })).toBeInTheDocument()

  fireEvent.click(button)
  expect(pause).toHaveBeenCalled()

  await act(async () => {
    setPaused(video, true)
    fireEvent.pause(video)
  })
  expect(fired()).toEqual(['video_started', 'video_paused'])
  expect(screen.getByRole('button', { name: 'Abspielen' })).toBeInTheDocument()
})

test('the bar seeks the clip, and the seek is still logged', async () => {
  const video = await mount()

  fireEvent.change(screen.getByRole('slider'), { target: { value: '42' } })
  expect(video.currentTime).toBe(42)

  // Assigning currentTime is what makes a real element fire these; jsdom does not.
  await act(async () => {
    fireEvent.seeking(video)
    fireEvent.seeked(video)
  })
  expect(fired()).toEqual(['video_seeked'])
  expect(enqueue.mock.calls[0][1]).toMatchObject({ payload: { from: 0, to: 42 } })
})

test('reaching the end completes the case rather than pausing it', async () => {
  const onEnded = vi.fn()
  const video = await mount({ onEnded })

  await act(async () => {
    fireEvent.ended(video)
    // Browsers pause on ended; that must not read as the participant pausing.
    setPaused(video, true)
    fireEvent.pause(video)
  })

  expect(onEnded).toHaveBeenCalled()
  expect(fired()).toEqual(['video_completed'])
})
