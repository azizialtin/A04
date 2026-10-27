import { useTranslation } from 'react-i18next'
import StudyText from '../StudyText'
import type { SessionStep } from '../../api/participant'

export default function SectionIntroScreen({
  step,
  onContinue,
  busy,
}: {
  step: Extract<SessionStep, { kind: 'section_intro' }>
  onContinue: () => void
  busy: boolean
}) {
  const { t } = useTranslation()
  return (
    <section className="panel panel--form section-intro">
      <h2>{step.title}</h2>
      <StudyText text={step.body} className="lead" />
      {step.time_limit_seconds !== null && (
        <p className="muted">{t('ck_section.intro_timer_note')}</p>
      )}
      <div className="panel__actions">
        <button className="btn btn-primary" disabled={busy} onClick={onContinue}>
          {t('questionnaire.submit')}
        </button>
      </div>
    </section>
  )
}
