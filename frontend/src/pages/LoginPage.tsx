import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { authApi } from '../api/participant'
import LanguageSwitcher from '../components/LanguageSwitcher'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'

export default function LoginPage() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [id, setId] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!id.trim() || busy) return
    setBusy(true)
    try {
      const { access_token } = await authApi.participantLogin(id.trim())
      login(access_token)
      navigate('/session', { replace: true })
    } catch {
      toast.show(t('login.error_unknown'), 'error')
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
        <button type="submit" className="btn btn-primary btn-lg" disabled={!id.trim() || busy}>
          {busy ? t('common.loading') : t('login.submit')}
        </button>
      </form>
    </div>
  )
}
