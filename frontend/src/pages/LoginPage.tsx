import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react'
import { isAxiosError } from 'axios'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { authApi } from '../api/participant'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import { reloadIfOutdated, reloadPage } from '../lib/pageVersion'

// What was typed when the page reloaded itself, so it is still there afterwards.
const KEPT_ID = 'a04.login.kept_id'
const RECHECK_GAP_MS = 10_000

function keptId(): { id: string; submitted: boolean } | null {
  try {
    const kept: unknown = JSON.parse(window.sessionStorage.getItem(KEPT_ID) ?? 'null')
    if (typeof kept !== 'object' || kept === null) return null
    const { id, submitted } = kept as { id?: unknown; submitted?: unknown }
    return typeof id === 'string' ? { id, submitted: submitted === true } : null
  } catch {
    return null
  }
}

function keepId(id: string, submitted: boolean) {
  try {
    window.sessionStorage.setItem(KEPT_ID, JSON.stringify({ id, submitted }))
  } catch {
    /* the id is typed again */
  }
}

export default function LoginPage() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [id, setId] = useState(() => keptId()?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [outdated, setOutdated] = useState(false)
  const typed = useRef(id)
  typed.current = id
  const signingIn = useRef(false)
  // Set while this load is the reload a pressed button caused and nobody has said so yet.
  const unexplained = useRef(false)
  const explain = useRef(() => {})
  explain.current = () => toast.show(t('login.reloaded'))
  const waiting = useRef(new Set<AbortController>())

  // The answer can come after the sign-in has opened a session, or after this
  // page has gone. A withdrawn question neither reloads nor keeps an id.
  const withdraw = useCallback(() => {
    waiting.current.forEach((question) => question.abort())
    waiting.current.clear()
  }, [])
  const pageState = useCallback(
    async (kept: () => string, submitted: boolean, timeoutMs?: number) => {
      const question = new AbortController()
      waiting.current.add(question)
      const state = await reloadIfOutdated({
        timeoutMs,
        signal: question.signal,
        beforeReload: () => keepId(kept(), submitted),
      })
      waiting.current.delete(question)
      return question.signal.aborted ? null : state
    },
    [],
  )

  useEffect(() => {
    const kept = keptId()
    if (!kept) return
    try {
      window.sessionStorage.removeItem(KEPT_ID)
    } catch {
      /* it is overwritten by the next reload */
    }
    unexplained.current = kept.submitted
  }, [])

  // This is where a lab tab waits between participants, sometimes overnight.
  // Releases are a day apart at most, so it looks when someone comes back to
  // it rather than on a timer; the sign-in below looks once more.
  useEffect(() => {
    let checkedAt = -Infinity
    const check = async () => {
      if (signingIn.current || performance.now() - checkedAt < RECHECK_GAP_MS) return
      checkedAt = performance.now()
      const state = await pageState(() => typed.current, false)
      if (state === null || state === 'reloading') return
      // The button was pressed and the page reloaded instead: say so once the
      // server confirms the reload brought its files. If it did not, the notice
      // below is the explanation.
      if (unexplained.current && state === 'current') explain.current()
      unexplained.current = false
      if (state !== 'unknown') setOutdated(state === 'outdated')
    }
    const whenVisible = () => {
      if (document.visibilityState === 'visible') void check()
    }
    const onFocus = () => void check()
    void check()
    document.addEventListener('visibilitychange', whenVisible)
    window.addEventListener('focus', onFocus)
    return () => {
      withdraw()
      document.removeEventListener('visibilitychange', whenVisible)
      window.removeEventListener('focus', onFocus)
    }
  }, [pageState, withdraw])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const participantId = id.trim()
    if (!participantId || busy) return
    setBusy(true)
    // From here the sign-in decides, and looks once more itself.
    signingIn.current = true
    unexplained.current = false
    withdraw()
    // A session must not start on a page the server has since replaced. A
    // server that does not answer in time does not hold the participant up.
    const state = await pageState(() => participantId, true, 3000)
    if (state === null || state === 'reloading') return
    if (state !== 'unknown') setOutdated(state === 'outdated')
    try {
      const { access_token } = await authApi.participantLogin(participantId)
      login(access_token)
      navigate('/session', { replace: true })
    } catch (error) {
      const status = isAxiosError(error) ? error.response?.status : undefined
      const key =
        status === 403
          ? 'error_completed'
          : status === 401
            ? 'error_unknown'
            : status === 429
              ? 'error_rate_limit'
              : 'error_connection'
      toast.show(t(`login.${key}`), status === 403 ? 'info' : 'error')
      signingIn.current = false
      setBusy(false)
    }
  }

  return (
    <div className="fullpage">
      <div className="topbar-corner">
        <LanguageSwitcher />
      </div>
      <form className="panel panel--narrow" onSubmit={submit}>
        <h1 className="brand">A04</h1>
        <label className="label" htmlFor="pid">
          {t('login.id_label')}
        </label>
        <input
          id="pid"
          className="input"
          value={id}
          onChange={(e) => setId(e.target.value)}
          placeholder={t('login.id_placeholder')}
          autoComplete="off"
          autoFocus
        />
        <p className="muted">{t('login.hint')}</p>
        {outdated && (
          <div className="login-outdated" role="status">
            <p>{t('login.outdated')}</p>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                keepId(id, false)
                reloadPage()
              }}
            >
              {t('login.reload')}
            </button>
          </div>
        )}
        <button type="submit" className="btn btn-primary btn-lg" disabled={!id.trim() || busy}>
          {busy ? t('common.loading') : t('login.submit')}
        </button>
      </form>
    </div>
  )
}
