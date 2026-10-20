import type { ReactNode } from 'react'

interface Props {
  open: boolean
  title: string
  onClose: () => void
  children: ReactNode
  aoiId?: string
}

export default function Modal({ open, title, onClose, children, aoiId = 'dialog' }: Props) {
  if (!open) return null
  return (
    <div
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
