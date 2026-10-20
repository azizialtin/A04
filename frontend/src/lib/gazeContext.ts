import type { GazeContext } from '../api/gaze'
import type { SessionStep } from '../api/participant'

export function gazeContext(step: SessionStep): GazeContext | null {
  switch (step.kind) {
    case 'questionnaire':
      return {
        video_id: null,
        step_kind: step.kind,
        step_index: step.index,
        questionnaire_id: step.questionnaire_id,
      }
    case 'case_video':
    case 'diagnosis':
      return { video_id: step.video_id, step_kind: step.kind, step_index: step.index }
    case 'case_outro':
      return step.questionnaire_id === null
        ? null
        : {
            video_id: step.video_id,
            step_kind: step.kind,
            step_index: step.index,
            questionnaire_id: step.questionnaire_id,
          }
    default:
      return null
  }
}
