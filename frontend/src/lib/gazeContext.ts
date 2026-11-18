import type { GazeContext } from '../api/gaze'
import type { SessionStep } from '../api/participant'

export function gazeContext(step: SessionStep): GazeContext | null {
  return step.kind === 'case_video'
    ? { video_id: step.video_id, step_kind: step.kind, step_index: step.index }
    : null
}
