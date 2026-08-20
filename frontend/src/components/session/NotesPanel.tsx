import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  getVideoTime: () => number
  onSnapshot: (videoTimeSeconds: number, text: string) => void
  /** The box was clicked into. */
  onFocus?: () => void
  /** A stretch of typing ended, with how long it ran for. */
  onTypingBurst?: (durationMs: number, length: number) => void
  initialText?: string
  debounceMs?: number
}

/**
 * Notes box for the case screen. Saves debounced snapshots (and one on blur)
 * tagged with the current video time, so the think-aloud replay can reveal the
 * notes in sync with the clip.
 *
 * On a refresh mid-case it comes back with the last saved snapshot: the
 * step pointer resumes the run, and this resumes what the participant could
 * see while writing.
 */
export default function NotesPanel({
  getVideoTime,
  onSnapshot,
  onFocus,
  onTypingBurst,
  initialText = '',
  debounceMs = 800,
}: Props) {
  const { t } = useTranslation()
  const [text, setText] = useState(initialText)
  const latest = useRef(initialText)
  const saved = useRef(initialText)
  const touched = useRef(false)
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
    const started = burstStart.current
    burstStart.current = null
    if (latest.current === saved.current) return
    saved.current = latest.current
    // First to last keystroke. Measuring to here instead would add the debounce
    // on one path and not the other, and the two would not be comparable.
    if (started !== null) onTypingBurst?.(burstEnd.current - started, latest.current.length)
    onSnapshot(getVideoTime(), latest.current)
  }

  const handleChange = (value: string) => {
    touched.current = true
    setText(value)
    latest.current = value
    burstEnd.current = Date.now()
    if (burstStart.current === null) burstStart.current = burstEnd.current
    if (timer.current) window.clearTimeout(timer.current)
    timer.current = window.setTimeout(flush, debounceMs)
  }

  const handleBlur = () => {
    if (timer.current) window.clearTimeout(timer.current)
    flush()
  }

  useEffect(() => () => window.clearTimeout(timer.current), [])

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
}
