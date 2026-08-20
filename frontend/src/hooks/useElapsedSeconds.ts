import { useCallback, useRef } from 'react'

/**
 * Seconds since the screen appeared, read on demand at submit time. Both the
 * diagnosis and the per-case questionnaires record how long they took, and
 * that number is part of the study's data — not a diagnostic.
 */
export function useElapsedSeconds(): () => number {
  const start = useRef(Date.now())
  return useCallback(() => Math.max(0, Math.round((Date.now() - start.current) / 1000)), [])
}
