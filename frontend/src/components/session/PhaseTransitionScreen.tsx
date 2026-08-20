import { useTranslation } from 'react-i18next'

export default function PhaseTransitionScreen({
  phaseNumber,
  onContinue,
}: {
  phaseNumber: number
  onContinue: () => void
}) {
  const { t } = useTranslation()
  return (
    <div className="fullpage">
      <div className="panel panel--center">
        <div className="phase-badge">{t('phase.label', { n: phaseNumber })}</div>
        <button type="button" className="btn btn-primary btn-lg" onClick={onContinue}>
          {t('common.continue')}
        </button>
      </div>
    </div>
  )
}
