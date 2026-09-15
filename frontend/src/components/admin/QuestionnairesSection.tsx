import { useState } from 'react'

import type { AxiosError } from 'axios'

import {
  useCreateQuestionnaire,
  useDeleteQuestionnaire,
  useQuestionnaires,
  useSeedQuestionnaires,
} from '../../hooks/admin'

const PLACEMENTS = [
  ['pre_test', 'Vortest (eigene Seite, einmal pro Durchlauf)'],
  ['diagnosis', 'Auf der Diagnose-Seite (nur einmal pro Studie)'],
  ['case_outro', 'Nach dem Fall (nur einmal pro Studie)'],
] as const

const EXAMPLE =
  '[\n  {"id": "q1", "type": "likert", "text": "Frage …", "scale_min": 1, "scale_max": 5}\n]'

// Only a 409 means "that placement is taken"; an expired session or a dropped
// connection must not send the researcher off deleting a battery.
const isConflict = (error: unknown) => (error as AxiosError)?.response?.status === 409

export default function QuestionnairesSection({ studyId }: { studyId: number }) {
  const qs = useQuestionnaires(studyId)
  const create = useCreateQuestionnaire(studyId)
  const seed = useSeedQuestionnaires(studyId)
  const del = useDeleteQuestionnaire(studyId)

  const [placement, setPlacement] = useState('pre_test')
  const [title, setTitle] = useState('')
  const [order, setOrder] = useState('0')
  const [json, setJson] = useState(EXAMPLE)
  const [err, setErr] = useState('')

  const submit = () => {
    let questions: unknown
    try {
      questions = JSON.parse(json)
    } catch {
      setErr('Ungültiges JSON.')
      return
    }
    if (!Array.isArray(questions)) {
      setErr('Die Fragen müssen ein JSON-Array sein.')
      return
    }
    if (!title.trim()) {
      setErr('Titel erforderlich.')
      return
    }
    setErr('')
    create.mutate(
      {
        placement,
        title: title.trim(),
        order_index: Number(order) || 0,
        questions: questions as unknown[],
      },
      {
        onSuccess: () => setTitle(''),
        onError: (error) =>
          setErr(
            isConflict(error)
              ? 'Für diese Platzierung existiert bereits ein Fragebogen.'
              : 'Der Fragebogen konnte nicht angelegt werden.',
          ),
      },
    )
  }

  const remove = (id: number) => {
    if (!window.confirm('Fragebogen endgültig löschen?')) return
    del.mutate(
      { id },
      {
        onError: () => {
          if (window.confirm('Es existieren bereits Antworten. Mit Antworten löschen?')) {
            del.mutate({ id, force: true })
          }
        },
      },
    )
  }

  return (
    <div>
      <div className="card form">
        <h2>Standard-Fragebögen</h2>
        <p className="muted">
          Demographie, Fachdidaktik, Fachwissen, Diagnose-Sicherheit und die Fragen nach dem Fall –
          so, wie sie im Datenlexikon der Studie stehen. Neue Studien bekommen sie automatisch;
          fehlende werden hier ergänzt, vorhandene bleiben unverändert.
        </p>
        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => seed.mutate()}
          disabled={seed.isPending}
        >
          Fehlende Standard-Fragebögen anlegen
        </button>
        {seed.isSuccess && (
          <span className="muted" style={{ marginLeft: 12 }}>
            {seed.data.length === 0 ? 'Nichts zu ergänzen.' : `${seed.data.length} angelegt.`}
          </span>
        )}
      </div>

      <div className="card form">
        <h2>Fragebogen anlegen</h2>
        <div className="form-row">
          <label className="label">Platzierung</label>
          <select
            className="input"
            value={placement}
            onChange={(e) => setPlacement(e.target.value)}
          >
            {PLACEMENTS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="label">Titel</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">Reihenfolge</label>
          <input
            className="input"
            type="number"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label">Fragen (JSON-Array)</label>
          <textarea
            className="textarea"
            style={{ minHeight: 160, fontFamily: 'ui-monospace, monospace' }}
            value={json}
            onChange={(e) => setJson(e.target.value)}
          />
          <p className="muted small">
            Aufeinanderfolgende Einfachauswahl-Fragen mit denselben Optionen und demselben Wert
            unter <code>"matrix"</code> werden als eine Tabelle gezeigt: die Antworten einmal oben,
            eine Zeile pro Frage.
          </p>
        </div>
        {err && <p className="error-text">{err}</p>}
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={create.isPending}
        >
          Anlegen
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Platzierung</th>
            <th>Titel</th>
            <th>Fragen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(qs.data ?? []).map((q) => (
            <tr key={q.id}>
              <td>{q.id}</td>
              <td>{q.placement}</td>
              <td>{q.title}</td>
              <td>{q.questions.length}</td>
              <td>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(q.id)}>
                  Löschen
                </button>
              </td>
            </tr>
          ))}
          {qs.data?.length === 0 && (
            <tr>
              <td colSpan={5} className="muted">
                Noch keine Fragebögen.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
