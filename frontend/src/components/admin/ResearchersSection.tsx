import type { AxiosError } from 'axios'
import { useState } from 'react'

import type { Researcher } from '../../api/admin'
import {
  useChangeMyPassword,
  useCreateResearcher,
  useResearchers,
  useResetResearcherPassword,
  useRevokeResearcherSessions,
} from '../../hooks/admin'
import { generatePassword, MIN_PASSWORD_LENGTH } from '../../lib/password'
import Modal from '../Modal'
import { useToast } from '../Toast'

const TOO_SHORT = `Mindestens ${MIN_PASSWORD_LENGTH} Zeichen.`
const HINT = `mindestens ${MIN_PASSWORD_LENGTH} Zeichen`

/**
 * The admin accounts, from the admin UI: what the CLI's create-admin,
 * reset-password and revoke-sessions do, for a researcher without a shell on
 * the server. Every account is an admin with every right — there are no
 * roles — so the page says so, and a password set here is shown once, to be
 * handed over in person rather than mailed.
 */
export default function ResearchersSection({
  me,
  onNewToken,
}: {
  /** The signed-in admin's email, to mark their own row. */
  me: string | null
  /** Called with the fresh token after the admin changes their own password. */
  onNewToken: (token: string) => void
}) {
  const researchers = useResearchers()
  const revoke = useRevokeResearcherSessions()
  const toast = useToast()
  const [resetting, setResetting] = useState<Researcher | null>(null)
  const [changingOwn, setChangingOwn] = useState(false)

  const revokeSessions = (r: Researcher) => {
    if (
      !window.confirm(
        `Alle Sitzungen von ${r.email} beenden? Die Person muss sich neu anmelden; ihr Passwort bleibt.`,
      )
    )
      return
    revoke.mutate(r.id, {
      onSuccess: () => toast.show(`Sitzungen von ${r.email} beendet.`, 'success'),
      onError: () => toast.show('Die Sitzungen konnten nicht beendet werden.', 'error'),
    })
  }

  return (
    <>
      <h2 className="section-head">Zugänge</h2>
      <div className="card">
        <p className="muted">
          Jeder Zugang hier ist ein Admin mit allen Rechten; Rollen gibt es nicht. Ein neues
          Passwort wird einmal angezeigt – geben Sie es persönlich weiter, nicht per E-Mail.
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>E-Mail</th>
                <th>Seit</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {(researchers.data ?? []).map((r) => (
                <tr key={r.id}>
                  <td>
                    {r.name || <span className="muted">–</span>}
                    {r.email === me && <span className="muted"> (Sie)</span>}
                  </td>
                  <td>{r.email}</td>
                  <td>{r.created_at ? new Date(r.created_at).toLocaleDateString('de-DE') : ''}</td>
                  <td className="actions">
                    {r.email === me ? (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => setChangingOwn(true)}
                      >
                        Eigenes Passwort ändern
                      </button>
                    ) : (
                      <>
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          onClick={() => setResetting(r)}
                        >
                          Passwort zurücksetzen
                        </button>{' '}
                        <button
                          type="button"
                          className="btn btn-ghost btn-sm"
                          disabled={revoke.isPending}
                          onClick={() => revokeSessions(r)}
                        >
                          Sitzungen beenden
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {researchers.isLoading && (
                <tr>
                  <td colSpan={4} className="muted">
                    Wird geladen…
                  </td>
                </tr>
              )}
              {researchers.isError && (
                <tr>
                  <td colSpan={4} className="error-text">
                    Zugänge nicht verfügbar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <CreateAccountForm />
      </div>
      {resetting && (
        <ResetPasswordDialog researcher={resetting} onClose={() => setResetting(null)} />
      )}
      {changingOwn && (
        <OwnPasswordDialog onClose={() => setChangingOwn(false)} onNewToken={onNewToken} />
      )}
    </>
  )
}

function CreateAccountForm() {
  const create = useCreateResearcher()
  const toast = useToast()
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [handover, setHandover] = useState<{ email: string; password: string } | null>(null)

  const submit = () => {
    const address = email.trim()
    if (!address.includes('@')) return setProblem('Bitte eine E-Mail-Adresse angeben.')
    if (password.length < MIN_PASSWORD_LENGTH) return setProblem(`Passwort: ${TOO_SHORT}`)
    setProblem(null)
    create.mutate(
      { email: address, name: name.trim(), password },
      {
        onSuccess: (made) => {
          toast.show(`Zugang für ${made.email} angelegt.`, 'success')
          setHandover({ email: made.email, password })
          setName('')
          setEmail('')
          setPassword('')
        },
        onError: (error) =>
          setProblem(
            status(error) === 409
              ? 'Für diese E-Mail-Adresse gibt es schon einen Zugang.'
              : `Der Zugang konnte nicht angelegt werden. ${detail(error)}`,
          ),
      },
    )
  }

  return (
    <div className="form" style={{ marginTop: 16 }}>
      <h3>Neuer Zugang</h3>
      <div className="form-row">
        <label className="label" htmlFor="new-admin-name">
          Name
        </label>
        <input
          id="new-admin-name"
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="new-admin-email">
          E-Mail
        </label>
        <input
          id="new-admin-email"
          className="input"
          type="email"
          autoComplete="off"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>
      <PasswordRow id="new-admin-password" value={password} onChange={setPassword} />
      {problem && <p className="error-text">{problem}</p>}
      <button
        type="button"
        className="btn btn-primary"
        disabled={create.isPending}
        onClick={submit}
      >
        Zugang anlegen
      </button>
      {handover && (
        <Handover
          email={handover.email}
          password={handover.password}
          onDone={() => setHandover(null)}
        />
      )}
    </div>
  )
}

/** A password field with a button that fills in a generated one; shown in clear, it is being handed over. */
function PasswordRow({
  id,
  value,
  onChange,
  label = 'Passwort',
}: {
  id: string
  value: string
  onChange: (value: string) => void
  label?: string
}) {
  return (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label} <span className="muted small">({HINT})</span>
      </label>
      <div className="row-gap">
        <input
          id={id}
          className="input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => onChange(generatePassword())}
        >
          Vorschlag
        </button>
      </div>
    </div>
  )
}

/** The one time a password is shown: right after it was set, to be written down. */
function Handover({
  email,
  password,
  onDone,
}: {
  email: string
  password: string
  onDone: () => void
}) {
  const toast = useToast()
  const copy = () =>
    navigator.clipboard
      ?.writeText(password)
      .then(() => toast.show('Passwort kopiert.', 'success'))
      .catch(() => toast.show('Kopieren nicht möglich – bitte abschreiben.', 'error'))
  return (
    <div className="handover" role="status">
      <p>
        Passwort für <strong>{email}</strong>: <code>{password}</code>
      </p>
      <p className="muted small">
        Es wird nicht noch einmal angezeigt. Persönlich weitergeben, nicht per E-Mail; die Person
        kann es danach selbst ändern.
      </p>
      <button type="button" className="btn btn-secondary btn-sm" onClick={copy}>
        Kopieren
      </button>{' '}
      <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
        Ausblenden
      </button>
    </div>
  )
}

function ResetPasswordDialog({
  researcher,
  onClose,
}: {
  researcher: Researcher
  onClose: () => void
}) {
  const reset = useResetResearcherPassword()
  const toast = useToast()
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)

  const submit = () => {
    if (password.length < MIN_PASSWORD_LENGTH) return setProblem(TOO_SHORT)
    setProblem(null)
    reset.mutate(
      { id: researcher.id, password },
      {
        onSuccess: () => {
          toast.show(`Passwort für ${researcher.email} gesetzt.`, 'success')
          setDone(password)
        },
        onError: (error) =>
          setProblem(`Das Passwort konnte nicht gesetzt werden. ${detail(error)}`),
      },
    )
  }

  return (
    <Modal open title="Passwort zurücksetzen" onClose={onClose}>
      {done ? (
        <Handover email={researcher.email} password={done} onDone={onClose} />
      ) : (
        <>
          <p>
            Neues Passwort für <strong>{researcher.email}</strong>. Alle Sitzungen dieser Person
            enden damit.
          </p>
          <PasswordRow id="reset-password" value={password} onChange={setPassword} />
          {problem && <p className="error-text">{problem}</p>}
          <div className="modal__actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Abbrechen
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={reset.isPending}
              onClick={submit}
            >
              Passwort setzen
            </button>
          </div>
        </>
      )}
    </Modal>
  )
}

function OwnPasswordDialog({
  onClose,
  onNewToken,
}: {
  onClose: () => void
  onNewToken: (token: string) => void
}) {
  const change = useChangeMyPassword()
  const toast = useToast()
  const [current, setCurrent] = useState('')
  const [next, setNext] = useState('')
  const [again, setAgain] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  const submit = () => {
    if (next.length < MIN_PASSWORD_LENGTH) return setProblem(`Neues Passwort: ${TOO_SHORT}`)
    if (next !== again) return setProblem('Die Wiederholung stimmt nicht überein.')
    setProblem(null)
    change.mutate(
      { current, next },
      {
        onSuccess: (token) => {
          // The change ended the old session; carry on with the new one.
          onNewToken(token)
          toast.show('Passwort geändert.', 'success')
          onClose()
        },
        onError: (error) =>
          setProblem(
            status(error) === 400
              ? 'Das aktuelle Passwort stimmt nicht.'
              : `Das Passwort konnte nicht geändert werden. ${detail(error)}`,
          ),
      },
    )
  }

  const field = (
    id: string,
    label: string,
    value: string,
    set: (v: string) => void,
    autoComplete: string,
  ) => (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <input
        id={id}
        className="input"
        type="password"
        autoComplete={autoComplete}
        value={value}
        onChange={(e) => set(e.target.value)}
      />
    </div>
  )

  return (
    <Modal open title="Eigenes Passwort ändern" onClose={onClose}>
      {field('own-current', 'Aktuelles Passwort', current, setCurrent, 'current-password')}
      {field('own-next', `Neues Passwort (${HINT})`, next, setNext, 'new-password')}
      {field('own-again', 'Neues Passwort wiederholen', again, setAgain, 'new-password')}
      {problem && <p className="error-text">{problem}</p>}
      <div className="modal__actions">
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={change.isPending || !current}
          onClick={submit}
        >
          Passwort ändern
        </button>
      </div>
    </Modal>
  )
}

function status(error: unknown): number | undefined {
  return (error as AxiosError)?.response?.status
}

function detail(error: unknown): string {
  const data = (error as AxiosError<{ detail?: unknown }>)?.response?.data
  return typeof data?.detail === 'string' ? data.detail : ''
}
