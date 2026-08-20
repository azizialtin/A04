import { useTranslation } from 'react-i18next'

/** Text only: nothing is asked before a case, so the clip is one click away. */
export default function CaseIntroScreen({ onContinue }: { onContinue: () => void }) {
  const { t } = useTranslation()
  return (
    <div className="panel">
      <h2>{t('case_intro.title')}</h2>
      <p className="lead">{t('case_intro.body')}</p>
      <div className="panel__actions">
        <button type="button" className="btn btn-primary" onClick={onContinue}>
          {t('common.continue')}
        </button>
      </div>
    </div>
  )
}
