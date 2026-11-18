import type { SessionStep } from '../../api/participant'
import { useGazeCapture } from '../../hooks/useGazeCapture'
import { gazeContext } from '../../lib/gazeContext'

export default function SessionGazeCapture({ step }: { step: SessionStep }) {
  // Recording, verification, retries and diagnostic events continue in the
  // background. Setup details belong on the welcome page, outside the tasks.
  useGazeCapture(gazeContext(step))
  return null
}
