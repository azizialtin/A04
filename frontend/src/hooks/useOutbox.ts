import { useCallback, useEffect, useSyncExternalStore } from 'react'

import { drain, pending, retrying, start, stop, subscribe } from '../lib/outbox'

/**
 * Runs the outbox for the length of a participant's session and reports how
 * many writes are waiting and which have failed. Ordinary background saves
 * should not display the connection warning reserved for failed requests.
 */
export function useOutbox(participantId: string | undefined) {
  // Claimed while rendering rather than in the effect below: React runs child
  // effects before the parent's, so a session resumed straight onto a case
  // screen would log its "entered" event into an outbox with no owner yet, and
  // the queue drops those. start() is idempotent and touches only module state.
  // (Teardown is the mirror image, and stop() keeps the owner for that reason.)
  if (participantId) start(participantId)
  const snapshot = useCallback(() => (participantId ? pending(participantId) : 0), [participantId])
  const count = useSyncExternalStore(subscribe, snapshot)
  const retrySnapshot = useCallback(
    () => (participantId ? retrying(participantId) : 0),
    [participantId],
  )
  const failed = useSyncExternalStore(subscribe, retrySnapshot)

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

  return { pending: count, retrying: failed }
}
