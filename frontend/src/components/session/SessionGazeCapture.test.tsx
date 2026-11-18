import { render } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import type { SessionStep } from '../../api/participant'
import { useGazeCapture } from '../../hooks/useGazeCapture'
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

beforeEach(() => capture.mockClear())

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
  const { rerender } = render(<SessionGazeCapture step={excluded[0]} />)
  for (const step of excluded) {
    rerender(<SessionGazeCapture step={step} />)
    expect(capture).toHaveBeenLastCalledWith(null)
  }
})
