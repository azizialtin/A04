import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { DRAFT_PREFIX, clearDraft } from '../../hooks/useLocalDraft'

interface Props {
  getVideoTime: () => number
  onSnapshot: (videoTimeSeconds: number, text: string) => void
  /** The box was clicked into. */
  onFocus?: () => void
  /** A stretch of typing ended, with how long it ran for. */
  onTypingBurst?: (durationMs: number, length: number) => void
  initialText?: string
  debounceMs?: number
  draftKey?: string
}

export interface NotesPanelHandle {
  flush: () => void
}

function readDraft(key: string | undefined): string | null {
  try {
    return key ? window.localStorage.getItem(DRAFT_PREFIX + key) : null
  } catch {
    return null
  }
}

/** Debounced replay snapshots, with each keystroke retained locally until queued. */
const NotesPanel = forwardRef<NotesPanelHandle, Props>(function NotesPanel(
  {
    getVideoTime,
    onSnapshot,
    onFocus,
    onTypingBurst,
    initialText = '',
    debounceMs = 800,
    draftKey,
  },
  ref,
) {
  const { t } = useTranslation()
  const [restored] = useState(() => readDraft(draftKey))
  const [text, setText] = useState(restored ?? initialText)
  const latest = useRef(restored ?? initialText)
  // An empty recovered draft can mean the participant deleted older notes.
  const saved = useRef<string | null>(restored === null ? initialText : null)
  const touched = useRef(restored !== null)
  const timer = useRef<number | undefined>(undefined)
  const burstStart = useRef<number | null>(null)
  const burstEnd = useRef(0)

  // Saved notes arrive a moment after the screen does. Adopt them unless the
  // participant has already started typing over the empty box.
  useEffect(() => {
    if (touched.current || !initialText) return
    setText(initialText)
    latest.current = initialText
    saved.current = initialText
  }, [initialText])

  const flush = () => {
    window.clearTimeout(timer.current)
    const started = burstStart.current
    burstStart.current = null
    if (latest.current !== saved.current) {
      // Exclude the debounce from the measured typing duration.
      if (started !== null) onTypingBurst?.(burstEnd.current - started, latest.current.length)
      onSnapshot(getVideoTime(), latest.current)
      saved.current = latest.current
    }
    if (draftKey) clearDraft(draftKey)
  }
  const flushRef = useRef(flush)
  flushRef.current = flush
  useImperativeHandle(ref, () => ({ flush }))

  const handleChange = (value: string) => {
    touched.current = true
    setText(value)
    latest.current = value
    if (draftKey) {
      try {
        window.localStorage.setItem(DRAFT_PREFIX + draftKey, value)
      } catch {
        /* Keep the in-memory draft if local storage is unavailable. */
      }
    }
    burstEnd.current = Date.now()
    if (burstStart.current === null) burstStart.current = burstEnd.current
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => flushRef.current(), debounceMs)
  }

  const handleBlur = () => {
    if (timer.current) window.clearTimeout(timer.current)
    flush()
  }

  useEffect(() => {
    // Recover a draft even when the previous page never received pagehide.
    if (restored !== null) flushRef.current()
    const save = () => flushRef.current()
    const hide = () => {
      if (document.visibilityState === 'hidden') save()
    }
    window.addEventListener('pagehide', save)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('pagehide', save)
      document.removeEventListener('visibilitychange', hide)
      save()
    }
  }, [restored])

  return (
    <textarea
      className="textarea"
      value={text}
      onChange={(e) => handleChange(e.target.value)}
      onFocus={onFocus}
      onBlur={handleBlur}
      placeholder={t('case.notes_placeholder')}
      aria-label={t('case.notes_label')}
    />
  )
})

export default NotesPanel
