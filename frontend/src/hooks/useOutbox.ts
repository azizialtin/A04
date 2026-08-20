import { useEffect, useState } from 'react'

import { drain, pending, start, stop, subscribe } from '../lib/outbox'

/**
 * Runs the outbox for the length of a participant's session and reports how
 * many writes are still waiting, so the study manager can see a problem while
 * there is still time to do something about it.
 */
export function useOutbox(participantId: string | undefined): number {
  const [count, setCount] = useState(() => pending())

  // Claimed while rendering rather than in the effect below: React runs child
  // effects before the parent's, so a session resumed straight onto a case
  // screen would log its "entered" event into an outbox with no owner yet, and
  // the queue drops those. start() is idempotent and touches only module state.
  // (Teardown is the mirror image, and stop() keeps the owner for that reason.)
  if (participantId) start(participantId)

  useEffect(() => {
    if (!participantId) return
    start(participantId) // again after a strict-mode remount released it

    const retry = () => void drain()
    window.addEventListener('online', retry)
    document.addEventListener('visibilitychange', retry)

    return () => {
      window.removeEventListener('online', retry)
      document.removeEventListener('visibilitychange', retry)
      stop()
    }
  }, [participantId])

  useEffect(() => subscribe(setCount), [])

  return count
}
