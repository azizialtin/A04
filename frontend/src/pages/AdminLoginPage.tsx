import { useState, type FormEvent } from 'react'
import { useTranslation } from 'react-i18next'
import { useNavigate } from 'react-router-dom'

import { authApi } from '../api/participant'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'

export default function AdminLoginPage() {
  const { t } = useTranslation()
  const { login } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (!email || !password || busy) return
    setBusy(true)
    try {
      const { access_token } = await authApi.adminLogin(email, password)
      login(access_token)
      navigate('/admin', { replace: true })
    } catch {
      toast.show('Anmeldung fehlgeschlagen.', 'error')
      setBusy(false)
    }
  }

  return (
    <div className="fullpage">
      <form className="panel panel--narrow" onSubmit={submit}>
        <h1 className="brand">A04</h1>
        <label className="label" htmlFor="email">
          E-Mail
        </label>
        <input
          id="email"
          className="input"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
        />
        <label className="label" htmlFor="pw" style={{ marginTop: 12 }}>
          Passwort
        </label>
        <input
          id="pw"
          className="input"
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
        />
        <button type="submit" className="btn btn-primary btn-lg" disabled={!email || !password || busy}>
          {busy ? t('common.loading') : t('login.submit')}
        </button>
      </form>
    </div>
  )
}
