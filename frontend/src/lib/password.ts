/** The server's rule for researcher passwords; checked here first so the form can say so in German. */
export const MIN_PASSWORD_LENGTH = 12

// No 0/O, 1/l/I: a password read out or copied by hand must not be ambiguous.
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** A random password to hand a colleague, from the browser's own randomness. */
export function generatePassword(length = 16): string {
  const values = new Uint32Array(length)
  crypto.getRandomValues(values)
  return Array.from(values, (v) => ALPHABET[v % ALPHABET.length]).join('')
}
