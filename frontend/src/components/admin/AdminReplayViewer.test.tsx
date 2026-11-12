import { render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { AdminReplay } from '../../api/admin'
import AdminReplayViewer from './AdminReplayViewer'

const replay: AdminReplay = {
  recording_id: 1,
  participant_id: 'P1',
  video_id: 7,
  video_title: 'Case',
  video_url: '/screen/recording.mp4',
  source: 'screen',
  epoch_ms: 1700000000000,
  duration_ms: 30000,
  recorder: 'bridge',
  sampling_rate_hz: 120,
  plotted_points: 0,
  invalid_samples: 0,
  unmapped_samples: 0,
  offscreen_samples: 0,
  has_geometry: true,
  points: [],
}

test('admin warns about missing sound and still uses the same recording for native playback', () => {
  const { container } = render(
    <AdminReplayViewer
      replay={{ ...replay, audio_status: 'failed', audio_error: 'Interrupted' }}
      onClose={vi.fn()}
    />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('nicht vollständig aufgezeichnet')
  expect(screen.getByRole('status')).toHaveTextContent('Interrupted')
  expect(container.querySelector('video')?.getAttribute('src')).toContain(replay.video_url)
  expect(container.querySelector('audio')).toBeNull()
})

test('admin distinguishes historical audio with unknown status', () => {
  render(<AdminReplayViewer replay={replay} onClose={vi.fn()} />)
  expect(screen.getByRole('status')).toHaveTextContent('nicht geprüft')
})
