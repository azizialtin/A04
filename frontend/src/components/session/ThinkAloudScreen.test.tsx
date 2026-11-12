import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { ReplayData } from '../../api/participant'
import ThinkAloudScreen, { type ThinkAloudPosition } from './ThinkAloudScreen'

vi.mock('../../lib/screenCapture', () => ({ uploadSettled: () => Promise.resolve() }))

const replay: ReplayData = {
  video_url: '/uploads/screens/T-1/1.mp4',
  source: 'screen',
  recorder: 'bridge',
  sampling_rate_hz: 120,
  plotted_points: 12,
  invalid_samples: 0,
  unmapped_samples: 0,
  offscreen_samples: 0,
  has_geometry: true,
  points: [],
  epoch_ms: 1_700_000_000_000,
  duration_ms: 30_000,
}

vi.mock('../../hooks/participant', () => ({
  useVideoReplay: () => ({ data: replay, isLoading: false, isError: false }),
  useVideoNotes: () => ({ data: [], isLoading: false, isError: false }),
}))

const position = (over: Partial<ThinkAloudPosition> = {}): ThinkAloudPosition => ({
  phaseType: 'training',
  caseNumber: 5,
  caseTotal: 7,
  batchPosition: 1,
  batchSize: 1,
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  replay.source = 'screen'
  replay.audio_status = 'unknown'
})

test('says which case is playing, so a recording is never a guess', async () => {
  render(<ThinkAloudScreen videoId={1} position={position()} onComplete={vi.fn()} />)

  await waitFor(() => expect(screen.getByRole('heading')).toBeInTheDocument())
  expect(screen.getByText('Training · Fall 5 von 7')).toBeInTheDocument()
  // One recording, so the plain title and no warning about a block.
  expect(screen.getByRole('heading', { name: 'Lautes Denken' })).toBeInTheDocument()
  expect(screen.queryByText(/nacheinander die Aufzeichnungen/)).not.toBeInTheDocument()
})

test('a block of recordings is numbered, and announced once at its start', async () => {
  const { unmount } = render(
    <ThinkAloudScreen
      videoId={1}
      position={position({ batchPosition: 1, batchSize: 3 })}
      onComplete={vi.fn()}
    />,
  )

  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Lautes Denken 1 von 3' })).toBeInTheDocument(),
  )
  expect(
    screen.getByText(/nacheinander die Aufzeichnungen der letzten 3 Fälle/),
  ).toBeInTheDocument()
  unmount()

  // Second of the block: numbered, but the announcement is not repeated.
  render(
    <ThinkAloudScreen
      videoId={2}
      position={position({ caseNumber: 6, batchPosition: 2, batchSize: 3 })}
      onComplete={vi.fn()}
    />,
  )
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Lautes Denken 2 von 3' })).toBeInTheDocument(),
  )
  expect(screen.getByText('Training · Fall 6 von 7')).toBeInTheDocument()
  expect(screen.queryByText(/nacheinander die Aufzeichnungen/)).not.toBeInTheDocument()
})

test('a study can rename the screen and rewrite its hint, numbering included', async () => {
  render(
    <ThinkAloudScreen
      videoId={1}
      position={position({ batchPosition: 2, batchSize: 3 })}
      heading="Erzählen Sie"
      body={'Was haben Sie gesehen?\n\nUnd warum?'}
      onComplete={vi.fn()}
    />,
  )
  expect(await screen.findByRole('heading', { name: 'Erzählen Sie 2 von 3' })).toBeInTheDocument()
  expect(screen.getByText('Und warum?')).toBeInTheDocument()
  expect(screen.queryByText(/Sehen Sie sich die Aufzeichnung an/)).toBeNull()
})

test.each(['unknown', 'silent', 'failed', 'unavailable'] as const)(
  'shows an audio warning for %s without replacing the selected recording',
  async (audioStatus) => {
    replay.audio_status = audioStatus
    const { container } = render(<ThinkAloudScreen videoId={1} onComplete={vi.fn()} />)
    expect(await screen.findByRole('status')).toBeInTheDocument()
    expect(container.querySelector('video')?.getAttribute('src')).toContain(replay.video_url)
    expect(container.querySelector('audio')).toBeNull()
  },
)

test('confirmed recorded audio needs no second player or audio warning', async () => {
  replay.audio_status = 'captured'
  const { container } = render(<ThinkAloudScreen videoId={1} onComplete={vi.fn()} />)
  await screen.findByRole('heading')
  expect(screen.queryByRole('status')).toBeNull()
  expect(container.querySelectorAll('video')).toHaveLength(1)
  expect(container.querySelector('audio')).toBeNull()
})

test('clip fallback keeps its original sound without a screen-audio warning', async () => {
  replay.source = 'clip'
  render(<ThinkAloudScreen videoId={1} onComplete={vi.fn()} />)
  await screen.findByRole('heading')
  expect(screen.queryByRole('status')).toBeNull()
})
