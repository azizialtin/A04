import type { SessionStep } from '../../api/participant'
import { useGazeCapture } from '../../hooks/useGazeCapture'
import { gazeContext } from '../../lib/gazeContext'

export default function SessionGazeCapture({ step }: { step: SessionStep }) {
  useGazeCapture(gazeContext(step))
  return null
}
