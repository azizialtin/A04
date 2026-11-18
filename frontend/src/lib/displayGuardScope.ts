import type { SessionStep } from '../api/participant'
import type { DisplayGuardScope } from './displayGuard'

/** Keep the pilot's display checks independent of which screens collect gaze. */
export function displayGuardScope(step: SessionStep | undefined): DisplayGuardScope {
  if (!step || ['sosci', 'think_aloud', 'thanks'].includes(step.kind)) return 'suspended'
  // Calibration remains disabled in configuration. If explicitly enabled later,
  // its measurements still require the same protected display.
  if (
    ['calibration', 'case_video', 'questionnaire', 'diagnosis'].includes(step.kind) ||
    (step.kind === 'case_outro' && step.questionnaire_id !== null)
  )
    return 'required'
  return 'monitor'
}
