import { render } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import type { SessionStep } from '../../api/participant'
import { useGazeCapture } from '../../hooks/useGazeCapture'
import { reportGazeDelivery, resetGazeDeliverySession } from '../../lib/gazeDelivery'
import SessionGazeCapture from './SessionGazeCapture'

vi.mock('../../hooks/useGazeCapture', () => ({ useGazeCapture: vi.fn() }))

const capture = vi.mocked(useGazeCapture)
const base = { index: 3, completed: false }
const questionnaire: SessionStep = {
  ...base,
  kind: 'questionnaire',
  questionnaire_id: 12,
  placement: 'pre_test',
  title: 'CK',
  description: '',
  section: 'CK',
  questions: [],
  video_id: null,
  page: 1,
  page_count: 2,
}
const caseVideo: SessionStep = {
  ...base,
  kind: 'case_video',
  video_id: 7,
  title: 'Case',
  task_description: '',
  info_text: '',
  student_task_text: '',
  time_limit_seconds: null,
}
const diagnosis: SessionStep = {
  ...base,
  kind: 'diagnosis',
  video_id: 7,
  title: 'Diagnosis',
  task_description: '',
  section: 'diagnosis',
  questions: [],
}
const outro: SessionStep = {
  ...base,
  kind: 'case_outro',
  video_id: 7,
  phase_type: 'training',
  questionnaire_id: 15,
  title: 'Outro',
  section: 'outro',
  instruction: '',
  questions: [],
}

beforeEach(() => capture.mockReset())
afterEach(() => resetGazeDeliverySession())

test('only video screens own a gaze recording across the participant flow', () => {
  const { rerender } = render(<SessionGazeCapture step={questionnaire} />)
  expect(capture).toHaveBeenLastCalledWith(null)
  rerender(<SessionGazeCapture step={{ ...caseVideo, index: 8 }} />)
  expect(capture).toHaveBeenLastCalledWith({ video_id: 7, step_kind: 'case_video', step_index: 8 })
  rerender(<SessionGazeCapture step={{ ...diagnosis, index: 9 }} />)
  expect(capture).toHaveBeenLastCalledWith(null)
  rerender(<SessionGazeCapture step={{ ...outro, index: 10 }} />)
  expect(capture).toHaveBeenLastCalledWith(null)
})

test('all other participant screens are excluded from gaze measurement', () => {
  const excluded: SessionStep[] = [
    questionnaire,
    diagnosis,
    outro,
    { ...base, kind: 'calibration' },
    { ...base, kind: 'phase_transition', phase_type: 'training', phase_number: 1 },
    {
      ...base,
      kind: 'section_intro',
      section_key: 'ck',
      title: '',
      body: '',
      time_limit_seconds: null,
    },
    { ...base, kind: 'sosci', variant: 'pretest', url: '', id_param: 'id', participant_id: 'P1' },
    { ...base, kind: 'welcome' },
    { ...base, kind: 'thanks' },
    { ...base, kind: 'case_intro', phase_type: 'training', video_id: 7, title: '', body: '' },
    { ...outro, questionnaire_id: null },
    {
      ...base,
      kind: 'think_aloud',
      video_id: 7,
      title: '',
      phase_type: 'training',
      case_number: 1,
      case_total: 7,
      batch_position: 1,
      batch_size: 1,
    },
  ]
  const { container, rerender } = render(<SessionGazeCapture step={excluded[0]} />)
  for (const step of excluded) {
    rerender(<SessionGazeCapture step={step} />)
    expect(capture).toHaveBeenLastCalledWith(null)
    expect(container).toBeEmptyDOMElement()
  }
})

test.each([questionnaire, caseVideo, diagnosis, outro])(
  '$kind keeps capture setup and delivery warnings outside task screens',
  (step) => {
    const healthy = {
      state: 'tracking' as const,
      received: 24,
      valid: 20,
      issue: null,
      mappingVerified: true,
      retry: vi.fn(),
    }
    capture.mockReturnValue(healthy)
    const { container, rerender } = render(<SessionGazeCapture step={step} />)
    expect(capture).toHaveBeenCalledOnce()
    const context = capture.mock.calls[0][0]
    if (step.kind === 'case_video')
      expect(context).toMatchObject({ step_kind: step.kind, step_index: step.index })
    else expect(context).toBeNull()
    expect(container).toBeEmptyDOMElement()

    capture.mockReturnValue({
      ...healthy,
      state: 'bridge_unreachable',
      issue: 'upload_failed',
      mappingVerified: false,
    })
    reportGazeDelivery('upload_failed')
    rerender(<SessionGazeCapture step={step} />)
    expect(capture).toHaveBeenLastCalledWith(context)
    expect(container).toBeEmptyDOMElement()
  },
)
