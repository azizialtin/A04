import { useCallback, useState } from 'react'

// Namespaced so logging out can sweep every draft off a shared lab machine.
export const DRAFT_PREFIX = 'a04.draft.'

function read(key: string): string {
  try {
    return window.localStorage.getItem(DRAFT_PREFIX + key) ?? ''
  } catch {
    return '' // private mode, or storage disabled
  }
}

/**
 * Text kept on this machine until it is safely submitted. The diagnosis is
 * never sent to the server before submit, so without this a refresh — or a
 * browser crash — loses an answer the participant cannot be asked to write
 * twice.
 */
export function useLocalDraft(key: string): [string, (value: string) => void, () => void] {
  const [value, setValue] = useState(() => read(key))

  const update = useCallback(
    (next: string) => {
      setValue(next)
      try {
        window.localStorage.setItem(DRAFT_PREFIX + key, next)
      } catch {
        /* out of quota — the box still works, it just will not survive a reload */
      }
    },
    [key],
  )

  const clear = useCallback(() => {
    setValue('')
    try {
      window.localStorage.removeItem(DRAFT_PREFIX + key)
    } catch {
      /* nothing to clear */
    }
  }, [key])

  return [value, update, clear]
}

/** Drop one draft, once its text is safely on the server. */
export function clearDraft(key: string): void {
  try {
    window.localStorage.removeItem(DRAFT_PREFIX + key)
  } catch {
    /* nothing to clear */
  }
}

/** Drop every draft on this machine — the next participant must not see them. */
export function clearAllDrafts(): void {
  try {
    const keys = Object.keys(window.localStorage).filter((k) => k.startsWith(DRAFT_PREFIX))
    keys.forEach((k) => window.localStorage.removeItem(k))
  } catch {
    /* nothing to clear */
  }
}
