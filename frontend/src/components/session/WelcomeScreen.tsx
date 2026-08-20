import { useTranslation } from 'react-i18next'

// What the sitting consists of, in order. Shown up front so the participant
// knows the SoSciSurvey tab and the eye tracker are coming before they arrive.
const STEPS = ['questions', 'sosci', 'calibration', 'cases'] as const

export default function WelcomeScreen({
  participantId,
  onContinue,
}: {
  participantId: string
  onContinue: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="fullpage">
      <div className="panel">
        <h1>{t('welcome.title')}</h1>
        <p className="lead">{t('welcome.intro')}</p>

        <span className="label">{t('welcome.overview')}</span>
        <ol className="steps">
          {STEPS.map((key) => (
            <li key={key}>{t(`welcome.steps.${key}`)}</li>
          ))}
        </ol>

        <div className="id-badge">
          <span className="id-badge__label">{t('welcome.your_id')}</span>
          <strong className="id-badge__value">{participantId}</strong>
        </div>
        <p className="muted">{t('welcome.remember')}</p>
        <button type="button" className="btn btn-primary btn-lg" onClick={onContinue}>
          {t('welcome.continue')}
        </button>
      </div>
    </div>
  )
}
