import { useTranslation } from 'react-i18next'

interface Props {
  variant: 'pretest' | 'posttest'
  url: string
  idParam: string
  participantId: string
  onContinue: () => void
}

export default function SosciScreen({ variant, url, idParam, participantId, onContinue }: Props) {
  const { t } = useTranslation()
  const sep = url.includes('?') ? '&' : '?'
  const fullUrl = `${url}${sep}${idParam}=${encodeURIComponent(participantId)}`

  return (
    <div className="fullpage">
      <div className="panel">
        <h1>{t(`sosci.${variant}.title`)}</h1>
        <p className="lead">{t(`sosci.${variant}.body`)}</p>
        <a className="btn btn-primary btn-lg" href={fullUrl} target="_blank" rel="noopener noreferrer">
          {t('sosci.open')}
        </a>
        <p className="muted">{t('sosci.note')}</p>
        <button type="button" className="btn btn-secondary" onClick={onContinue}>
          {t('sosci.done')}
        </button>
      </div>
    </div>
  )
}
