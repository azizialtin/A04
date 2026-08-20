import { useState, type FormEvent } from 'react'
import { Link } from 'react-router-dom'

import { useCreateStudy, useStudies } from '../../hooks/admin'

export default function AdminStudyListPage() {
  const studies = useStudies()
  const createStudy = useCreateStudy()
  const [name, setName] = useState('')
  const [pre, setPre] = useState('')
  const [post, setPost] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!name.trim()) return
    createStudy.mutate(
      { name: name.trim(), sosci_pretest_url: pre.trim(), sosci_posttest_url: post.trim() },
      {
        onSuccess: () => {
          setName('')
          setPre('')
          setPost('')
        },
      },
    )
  }

  return (
    <div>
      <h1>Studien</h1>

      <form className="card form" onSubmit={submit}>
        <h2>Neue Studie</h2>
        <div className="form-row">
          <label className="label">Name</label>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">SoSci-Link (Vortest)</label>
          <input className="input" value={pre} onChange={(e) => setPre(e.target.value)} placeholder="https://…" />
        </div>
        <div className="form-row">
          <label className="label">SoSci-Link (Nachtest)</label>
          <input className="input" value={post} onChange={(e) => setPost(e.target.value)} placeholder="https://…" />
        </div>
        <button className="btn btn-primary" type="submit" disabled={!name.trim() || createStudy.isPending}>
          Anlegen
        </button>
      </form>

      {studies.isLoading ? (
        <p className="muted">Wird geladen…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Name</th>
              <th>Status</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(studies.data ?? []).map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td>{s.name}</td>
                <td>{s.is_active ? 'aktiv' : 'inaktiv'}</td>
                <td>
                  <Link className="btn btn-secondary btn-sm" to={`/admin/studies/${s.id}`}>
                    Öffnen
                  </Link>
                </td>
              </tr>
            ))}
            {studies.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Noch keine Studien.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
