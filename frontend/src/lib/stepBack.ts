import type { TFunction } from 'i18next'

import type { SessionStep } from '../api/participant'

/**
 * The supervisor's way back: Ctrl+Alt+Shift+B (Cmd+Alt+Shift+B on a Mac). A
 * chord no browser binds and no participant hits by accident; the screen
 * asks before it moves. On a Windows keyboard Ctrl+Alt is AltGr, which the
 * browser still reports as both keys held.
 */
export function isStepBackChord(
  e: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey' | 'code' | 'repeat'>,
): boolean {
  return (e.ctrlKey || e.metaKey) && e.altKey && e.shiftKey && e.code === 'KeyB' && !e.repeat
}

/** A screen as the supervisor would name it: its kind, and its title where it has one. */
export function stepLabel(step: SessionStep | undefined, t: TFunction): string {
  if (!step) return t('step_back.kinds.thanks')
  const kind = t(`step_back.kinds.${step.kind}`, { defaultValue: step.kind })
  const title = 'title' in step && step.title ? step.title : ''
  return title ? `${kind} – ${title}` : kind
}
