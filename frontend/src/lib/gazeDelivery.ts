/** Keep a failed final upload visible after its measured screen has unmounted. */
let warning: 'empty' | 'upload_failed' | null = null
let generation = 0
const listeners = new Set<() => void>()
export const gazeDeliveryWarning = () => warning
export function subscribeGazeDelivery(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
export const gazeDeliveryGeneration = () => generation
export function resetGazeDeliverySession() {
  generation++
  reportGazeDelivery(null)
}
export function reportGazeDelivery(value: typeof warning, owner = generation) {
  if (owner !== generation) return
  warning = value
  for (const listener of listeners) listener()
}
