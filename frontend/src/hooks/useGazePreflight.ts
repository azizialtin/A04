import { useCallback, useEffect, useRef, useState } from 'react'
import { openGazeConnection, type GazeHealth } from '../lib/gazeConnection'

/** Probe availability without requesting or processing gaze coordinates. */
export function useGazePreflight() {
  const [health, setHealth] = useState<GazeHealth>({ state: 'connecting', received: 0, valid: 0 })
  const connection = useRef<ReturnType<typeof openGazeConnection> | null>(null)
  const open = useCallback(() => {
    connection.current?.close()
    connection.current = openGazeConnection({
      probeOnly: true,
      onHealth: setHealth,
      onReady: () => {},
      onSample: () => {},
    })
  }, [])
  useEffect(() => {
    open()
    return () => connection.current?.close()
  }, [open])
  return {
    ...health,
    retry: open,
    close: () => {
      connection.current?.close()
      connection.current = null
    },
  }
}
