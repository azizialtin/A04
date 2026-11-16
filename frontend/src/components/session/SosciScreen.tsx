import { useId, useState } from 'react'
import { useTranslation } from 'react-i18next'

interface Props {
  variant: 'pretest' | 'posttest'
  pilot?: boolean
  url: string
  idParam: string
  participantId: string
  onContinue: () => void
}

function wasOpened(key: string): boolean {
  try {
    return window.sessionStorage.getItem(key) === '1'
  } catch {
    return false
  }
}

export default function SosciScreen({
  variant,
  url,
  idParam,
  participantId,
  onContinue,
  pilot = false,
}: Props) {
  const { t } = useTranslation()
  const sep = url.includes('?') ? '&' : '?'
  const fullUrl = `${url}${sep}${idParam}=${encodeURIComponent(participantId)}`
  const storageKey = `a04.sosci.opened.${JSON.stringify([participantId, variant, fullUrl])}`
  const [openedKeys, setOpenedKeys] = useState<Set<string>>(() => new Set())
  const opened = openedKeys.has(storageKey) || wasOpened(storageKey)
  const noteId = useId()

  const markOpened = () => {
    setOpenedKeys((keys) => new Set(keys).add(storageKey))
    try {
      window.sessionStorage.setItem(storageKey, '1')
    } catch {
      // Opening still works when the browser cannot persist the flag.
    }
  }

  return (
    <div className="fullpage">
      <div className="panel">
        <h1>{t(`sosci.${variant}.title`)}</h1>
        <p className="lead">
          {t(pilot && variant === 'posttest' ? 'pilot.sosci_post_body' : `sosci.${variant}.body`)}
        </p>
        <a
          className="btn btn-primary btn-lg"
          href={fullUrl}
          target="_blank"
          rel="noopener noreferrer"
          aria-describedby={noteId}
          onClick={markOpened}
          onAuxClick={(event) => {
            if (event.button === 1) markOpened()
          }}
        >
          {t('sosci.open')}
        </a>
        <p className="muted" id={noteId}>
          {t('sosci.note')}
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          disabled={!opened}
          aria-describedby={noteId}
          onClick={onContinue}
        >
          {t('sosci.done')}
        </button>
      </div>
    </div>
  )
}
