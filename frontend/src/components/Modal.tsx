import { useLayoutEffect, useRef, type ReactNode } from 'react'

const activeDialogs: HTMLElement[] = []

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button, input, select, textarea, [tabindex], [contenteditable="true"]',
    ),
  ).filter((element) => {
    if (element.tabIndex < 0 || element.matches(':disabled, input[type="hidden"]')) return false
    for (let current: HTMLElement | null = element; current; current = current.parentElement) {
      const style = window.getComputedStyle(current)
      if (
        current.hidden ||
        current.hasAttribute('inert') ||
        style.display === 'none' ||
        style.visibility === 'hidden'
      )
        return false
      if (current === dialog) break
    }
    return true
  })
}

interface Props {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  aoiId?: string
}

export default function Modal({ open, title, onClose, children, aoiId = 'dialog' }: Props) {
  const root = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  // A child with autoFocus may receive focus before the opening effect runs.
  const initialFocus = useRef(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  )
  if (open && !root.current) {
    initialFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
  }
  useLayoutEffect(() => {
    close.current = onClose
  }, [onClose])
  useLayoutEffect(() => {
    const dialog = root.current
    if (!open || !dialog) return
    const active = document.activeElement
    const previous =
      active instanceof HTMLElement && !dialog.contains(active) ? active : initialFocus.current
    activeDialogs.push(dialog)
    const focusFirst = () => (focusableElements(dialog)[0] ?? dialog).focus()
    if (!dialog.contains(document.activeElement)) focusFirst()

    const onKey = (event: KeyboardEvent) => {
      if (activeDialogs[activeDialogs.length - 1] !== dialog) return
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        close.current()
        return
      }
      if (event.key !== 'Tab') return
      const controls = focusableElements(dialog)
      const first = controls[0]
      const last = controls[controls.length - 1]
      const current = document.activeElement
      if (!first || !dialog.contains(current) || current === dialog) {
        event.preventDefault()
        ;(event.shiftKey ? (last ?? dialog) : (first ?? dialog)).focus()
      } else if (event.shiftKey && current === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && current === last) {
        event.preventDefault()
        first.focus()
      }
    }
    const containFocus = (event: FocusEvent) => {
      if (activeDialogs[activeDialogs.length - 1] !== dialog) return
      if (event.target instanceof Node && !dialog.contains(event.target)) focusFirst()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('focusin', containFocus)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('focusin', containFocus)
      const index = activeDialogs.lastIndexOf(dialog)
      if (index !== -1) activeDialogs.splice(index, 1)
      if (previous?.isConnected) previous.focus()
    }
  }, [open])
  if (!open) return null
  return (
    <div
      ref={root}
      tabIndex={-1}
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      data-aoi-modal={aoiId}
      aria-label={title}
      onClick={onClose}
    >
      <div className="modal" data-aoi={aoiId} onClick={(e) => e.stopPropagation()}>
        <div className="modal__header">
          <h3 className="modal__title">{title}</h3>
          <button type="button" className="btn btn-ghost" onClick={onClose} aria-label="Schließen">
            ✕
          </button>
        </div>
        <div className="modal__body">{children}</div>
      </div>
    </div>
  )
}
