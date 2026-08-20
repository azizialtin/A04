import { useTranslation } from 'react-i18next'

export default function ThanksScreen() {
  const { t } = useTranslation()
  return (
    <div className="fullpage">
      <div className="panel panel--center">
        <h1>{t('thanks.title')}</h1>
        <p className="lead">{t('thanks.body')}</p>
      </div>
    </div>
  )
}
