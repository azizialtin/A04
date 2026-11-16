import { useTranslation } from 'react-i18next'
import type { SessionStep } from '../../api/participant'
import StudyText from '../StudyText'

export default function TextPageScreen({
  step,
  onContinue,
  busy,
}: {
  step: Extract<SessionStep, { kind: 'text_page' }>
  onContinue: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  const title = step.title || t(`pilot.text_pages.${step.key}.title`)
  return (
    <section className="panel panel--form">
      {title && <h1 data-aoi="page_title">{title}</h1>}
      <StudyText text={step.body || t(`pilot.text_pages.${step.key}.body`)} className="lead" />
      <div className="panel__actions">
        <button className="btn btn-primary" disabled={busy} onClick={onContinue}>
          {t('common.continue')}
        </button>
      </div>
    </section>
  )
}
