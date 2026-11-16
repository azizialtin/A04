import type { SessionStep } from '../api/participant'
import type { DisplayGuardScope } from './displayGuard'
import { gazeContext } from './gazeContext'

/** Match capture ownership so the guard cannot drift from the measured pages. */
export function displayGuardScope(step: SessionStep | undefined): DisplayGuardScope {
  if (!step || ['sosci', 'think_aloud', 'thanks'].includes(step.kind)) return 'suspended'
  // Calibration remains disabled in configuration. If explicitly enabled later,
  // its measurements still require the same protected display.
  if (step.kind === 'calibration' || gazeContext(step) !== null) return 'required'
  return 'monitor'
}
