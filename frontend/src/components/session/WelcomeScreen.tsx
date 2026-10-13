import { useTranslation } from 'react-i18next'

import type { WelcomeTexts } from '../../api/participant'
import StudyText from '../StudyText'

// What the sitting consists of, in order. Shown up front so the participant
// knows the SoSciSurvey tab and the eye tracker are coming before they arrive.
// Calibration only appears when the app runs its own calibration step.
const ALL_STEPS = ['questions', 'sosci', 'calibration', 'cases'] as const

/**
 * The first screen. Its wording comes from the study where the researcher has
 * written any (`texts`), and from the app's own translations otherwise — field
 * by field, so a study can replace the introduction and keep the rest.
 */
export default function WelcomeScreen({
  participantId,
  onContinue,
  showCalibration = true,
  texts,
}: {
  participantId: string
  onContinue: () => void
  showCalibration?: boolean
  texts?: Partial<WelcomeTexts>
}) {
  const { t } = useTranslation()
  const defaultSteps = ALL_STEPS.filter((key) => key !== 'calibration' || showCalibration).map(
    (key) => t(`welcome.steps.${key}`),
  )
  const steps = texts?.welcome_steps?.length ? texts.welcome_steps : defaultSteps
  const intro = texts?.welcome_intro || t('welcome.intro')

  return (
    <div className="fullpage">
      <div className="panel">
        <h1>{texts?.welcome_title || t('welcome.title')}</h1>
        <StudyText text={intro} className="lead" />

        <span className="label">{t('welcome.overview')}</span>
        <ol className="steps">
          {steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>

        <div className="id-badge">
          <span className="id-badge__label">{t('welcome.your_id')}</span>
          <strong className="id-badge__value">{participantId}</strong>
        </div>
        <p className="muted">{texts?.welcome_note || t('welcome.remember')}</p>
        <button type="button" className="btn btn-primary btn-lg" onClick={onContinue}>
          {t('welcome.continue')}
        </button>
      </div>
    </div>
  )
}
