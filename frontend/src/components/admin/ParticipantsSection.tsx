import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'

import { adminApi, type AdminVideo } from '../../api/admin'
import { useCreateParticipants, useParticipants, useSetSequence, useVideos } from '../../hooks/admin'
import { generateIds } from '../../lib/adminIds'
import ParticipantStatsPanel from './ParticipantStatsPanel'
import { useToast } from '../Toast'

export default function ParticipantsSection({ studyId }: { studyId: number }) {
  const participants = useParticipants(studyId)
  const videos = useVideos(studyId)
  const create = useCreateParticipants(studyId)

  const [idsText, setIdsText] = useState('')
  const [prefix, setPrefix] = useState('TN-')
  const [count, setCount] = useState('10')
  const [sequential, setSequential] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [inspected, setInspected] = useState<string | null>(null)

  const submitCreate = () => {
    const ids = idsText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (ids.length) create.mutate(ids, { onSuccess: () => setIdsText('') })
  }

  return (
    <div>
      <div className="card form">
        <h2>Teilnehmer anlegen</h2>
        <div className="inline-form">
          <input className="input" style={{ maxWidth: 130 }} value={prefix} onChange={(e) => setPrefix(e.target.value)} />
          <input
            className="input"
            style={{ maxWidth: 90 }}
            type="number"
            value={count}
            onChange={(e) => setCount(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => setIdsText(generateIds(prefix, Number(count), { sequential }).join('\n'))}
          >
            IDs erzeugen
          </button>
        </div>
        <label className="checkbox-row">
          <input
            type="checkbox"
            checked={sequential}
            onChange={(e) => setSequential(e.target.checked)}
          />
          <span>
            Fortlaufend nummerieren (TN-001, TN-002 …). Ohne Haken werden zufällige Codes vergeben —
            die ID ist das einzige Anmeldemerkmal und sollte nicht erratbar sein.
          </span>
        </label>
        <div className="form-row" style={{ marginTop: 12 }}>
          <label className="label">IDs (eine pro Zeile)</label>
          <textarea className="textarea" value={idsText} onChange={(e) => setIdsText(e.target.value)} />
        </div>
        <button type="button" className="btn btn-primary" onClick={submitCreate} disabled={create.isPending}>
          Anlegen
        </button>
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Status</th>
            <th>Slots</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(participants.data ?? []).map((p) => (
            <tr key={p.id}>
              <td>{p.id}</td>
              <td>{p.status}</td>
              <td>{p.slot_count === 0 ? <span className="muted">Standard</span> : p.slot_count}</td>
              <td>
                <div className="inline-form">
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setSelected(p.id)}>
                    Sequenz
                  </button>
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setInspected(p.id)}>
                    Statistik
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {participants.data?.length === 0 && (
            <tr>
              <td colSpan={4} className="muted">
                Noch keine Teilnehmer.
              </td>
            </tr>
          )}
        </tbody>
      </table>

      {inspected && (
        <ParticipantStatsPanel participantId={inspected} onClose={() => setInspected(null)} />
      )}

      {selected && (
        <SequenceEditor
          participantId={selected}
          studyId={studyId}
          videos={videos.data ?? []}
          onClose={() => setSelected(null)}
        />
      )}
    </div>
  )
}

function SequenceEditor({
  participantId,
  studyId,
  videos,
  onClose,
}: {
  participantId: string
  studyId: number
  videos: AdminVideo[]
  onClose: () => void
}) {
  const detail = useQuery({
    queryKey: ['participant', participantId],
    queryFn: () => adminApi.getParticipant(participantId),
  })
  const setSeq = useSetSequence(studyId)
  const toast = useToast()
  const [items, setItems] = useState<{ video_id: number; phase_type: string; title: string }[]>([])
  const [pick, setPick] = useState('')

  useEffect(() => {
    if (detail.data) {
      setItems(detail.data.sequence.map((s) => ({ video_id: s.video_id, phase_type: s.phase_type, title: s.video_title })))
    }
  }, [detail.data])

  const locked = detail.data ? detail.data.status !== 'registered' : false

  const add = () => {
    const v = videos.find((x) => x.id === Number(pick))
    if (v) setItems([...items, { video_id: v.id, phase_type: v.phase_type, title: v.title }])
    setPick('')
  }

  const save = () =>
    setSeq.mutate(
      { id: participantId, items: items.map((it, idx) => ({ video_id: it.video_id, slot_index: idx, phase_type: it.phase_type })) },
      { onSuccess: onClose, onError: () => toast.show('Sequenz konnte nicht gespeichert werden.', 'error') },
    )

  return (
    <div className="card">
      <div className="flex-between">
        <h3 style={{ margin: 0 }}>Sequenz für {participantId}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Schließen
        </button>
      </div>
      {locked && <p className="error-text">Teilnehmer hat bereits begonnen – die Sequenz ist gesperrt.</p>}
      {!locked && items.length === 0 && (
        <p className="muted">
          Ohne eigene Zuweisung erhält dieser Teilnehmer automatisch die Standard-Reihenfolge der
          Studie (alle Videos in Phasen-Reihenfolge). Weisen Sie hier Videos zu, um die Reihenfolge
          individuell festzulegen.
        </p>
      )}
      <ol className="seq-list">
        {items.map((it, i) => (
          <li key={i} className="seq-item">
            <span>
              {i + 1}. {it.title} <span className="muted">({it.phase_type})</span>
            </span>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={locked}
              onClick={() => setItems(items.filter((_, idx) => idx !== i))}
            >
              Entfernen
            </button>
          </li>
        ))}
        {items.length === 0 && <li className="muted">Noch keine Videos zugewiesen.</li>}
      </ol>
      <div className="inline-form">
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} disabled={locked}>
          <option value="">Video wählen…</option>
          {videos.map((v) => (
            <option key={v.id} value={v.id}>
              {v.title} ({v.phase_type})
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-secondary" onClick={add} disabled={!pick || locked}>
          Hinzufügen
        </button>
        <button type="button" className="btn btn-primary" onClick={save} disabled={locked || setSeq.isPending}>
          Speichern
        </button>
      </div>
    </div>
  )
}
