// Participant ids. They are the whole credential — anyone who knows one can
// open that participant's run — so the default is a random code rather than a
// counter someone could walk from TN-001 upwards. Sequential ids stay available
// for studies that need them on pre-printed material.

// No 0/O, 1/I/L, 5/S, 2/Z, 8/B: these get read aloud and typed in by hand.
const ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679'
const MAX_IDS = 1000

export function randomCode(length = 5): string {
  const bytes = new Uint8Array(length)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('')
}

interface Options {
  /** Sequential counter instead of a random code. */
  sequential?: boolean
  /** Width of the counter, sequential only. */
  pad?: number
  /** Length of the random code. */
  length?: number
}

export function generateIds(prefix: string, count: number, options: Options = {}): string[] {
  const { sequential = false, pad = 3, length = 5 } = options
  const n = Math.max(0, Math.min(MAX_IDS, Math.floor(count || 0)))

  if (sequential) {
    return Array.from({ length: n }, (_, i) => `${prefix}${String(i + 1).padStart(pad, '0')}`)
  }

  // 25^5 is ~9.7 million codes, so collisions within a study are vanishingly
  // rare — but a researcher asking for 40 ids should get 40.
  const ids = new Set<string>()
  while (ids.size < n) ids.add(`${prefix}${randomCode(length)}`)
  return [...ids]
}
