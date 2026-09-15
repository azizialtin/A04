import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { bridgeCanRecord, prepareCapture } from '../../lib/screenCapture'
import { paragraphs } from '../../lib/text'

/**
 * Text only: nothing is asked before a case, so the clip is one click away.
 * The wording is the study's where the researcher has written any, and the
 * app's own otherwise.
 *
 * That click is also where the page secures a screen capture when no bridge
 * will make one: the browser only shows its picker from a user gesture, and
 * this is the last one before the clip. With the bridge in place the button
 * behaves as before.
 */
export default function CaseIntroScreen({
  title,
  body,
  onContinue,
}: {
  title?: string
  body?: string
  onContinue: () => void
}) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)

  // Warm the probe so the click does not spend its gesture waiting on it.
  useEffect(() => {
    void bridgeCanRecord()
  }, [])

  const proceed = async () => {
    setBusy(true)
    try {
      await prepareCapture()
    } catch {
      /* the run does not stop for a capture */
    } finally {
      // Always: `onContinue` can fail (a blip on the progress PATCH), and a
      // button left disabled would strand the participant on this screen with
      // nothing to click.
      setBusy(false)
    }
    onContinue()
  }

  const lines = body ? paragraphs(body) : [t('case_intro.body')]

  return (
    <div className="panel">
      <h2>{title || t('case_intro.title')}</h2>
      {lines.map((line, i) => (
        <p key={i} className="lead">
          {line}
        </p>
      ))}
      <div className="panel__actions">
        <button
          type="button"
          className="btn btn-primary"
          onClick={() => void proceed()}
          disabled={busy}
        >
          {busy ? t('case_intro.preparing') : t('common.continue')}
        </button>
      </div>
    </div>
  )
}
