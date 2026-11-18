/** Human-readable recovery version, also stored with technical session diagnostics. */
export const APP_VERSION = '2026-11-18.2'

export function appBundle(): string {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')
  if (!script) return 'development'
  try {
    return new URL(script.src, location.href).pathname.split('/').pop() || 'unknown'
  } catch {
    return 'unknown'
  }
}
