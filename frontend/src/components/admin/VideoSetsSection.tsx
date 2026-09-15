import { useEffect, useRef, useState } from 'react'

import type { AdminVideo, VideoSet } from '../../api/admin'
import {
  useCreateVideoSet,
  useDeleteVideoSet,
  useUpdateVideoSet,
  useVideoSets,
  useVideos,
} from '../../hooks/admin'
import { useToast } from '../Toast'

const PHASE_LABEL: Record<string, string> = {
  pre_test: 'Vortest',
  training: 'Training',
  post_test: 'Nachtest',
}

interface Slot {
  video_id: number
  phase_type: string
  title: string
}

/**
 * The study's video sets: two fixed orders, of which every participant is
 * dealt one at their first login. The deal is balanced — whichever set has
 * fewer participants gets the next one, a tie is a coin toss — so the study
 * ends up half and half rather than wherever chance left it.
 */
export default function VideoSetsSection({ studyId }: { studyId: number }) {
  const sets = useVideoSets(studyId)
  const videos = useVideos(studyId)
  const create = useCreateVideoSet(studyId)
  const toast = useToast()
  const [name, setName] = useState('')

  const existing = sets.data ?? []
  // The design talks about A and B; offer the next letter without insisting.
  const suggestion = existing.length === 0 ? 'A' : existing.length === 1 ? 'B' : ''

  const submit = () => {
    const chosen = (name || suggestion).trim()
    if (!chosen) return
    create.mutate(
      { name: chosen, items: [] },
      {
        onSuccess: () => setName(''),
        onError: () => toast.show('Ein Set mit diesem Namen gibt es schon.', 'error'),
      },
    )
  }

  return (
    <div>
      <div className="card form">
        <h2>Videosets</h2>
        <p className="muted">
          Legen Sie zwei feste Reihenfolgen an (z. B. A und B). Jede Person, für die keine
          individuelle Sequenz eingestellt ist, bekommt bei ihrer ersten Anmeldung eines der Sets
          zugelost. Die Zuteilung wird ausgeglichen: Es gewinnt immer das Set mit den bisher
          wenigsten Teilnehmern, bei Gleichstand entscheidet der Zufall — so arbeitet am Ende die
          eine Hälfte mit dem einen, die andere Hälfte mit dem anderen Set.
        </p>
        <div className="inline-form">
          <input
            className="input"
            style={{ maxWidth: 160 }}
            placeholder={suggestion ? `Name (z. B. ${suggestion})` : 'Name'}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary"
            onClick={submit}
            disabled={create.isPending || (!name.trim() && !suggestion)}
          >
            Set anlegen
          </button>
        </div>
      </div>

      {/* Two sets of different lengths means half the sample works through a
          different number of cases — almost always a slip rather than a design. */}
      {new Set(existing.filter((s) => s.items.length).map((s) => s.items.length)).size > 1 && (
        <p className="warn-text">
          Die Sets sind unterschiedlich lang (
          {existing
            .filter((s) => s.items.length)
            .map((s) => `${s.name}: ${s.items.length}`)
            .join(', ')}
          ). Dann bearbeitet die eine Hälfte der Teilnehmenden mehr Fälle als die andere.
        </p>
      )}

      {existing.map((set) => (
        <VideoSetEditor key={set.id} set={set} videos={videos.data ?? []} studyId={studyId} />
      ))}
      {sets.data?.length === 0 && (
        <p className="muted">
          Noch keine Sets. Ohne Sets erhalten Teilnehmer ohne eigene Sequenz die
          Standard-Reihenfolge der Studie (alle Videos in Phasen-Reihenfolge).
        </p>
      )}
    </div>
  )
}

function phaseSummary(items: Slot[]): string {
  const counts = new Map<string, number>()
  for (const it of items) counts.set(it.phase_type, (counts.get(it.phase_type) ?? 0) + 1)
  return ['pre_test', 'training', 'post_test']
    .filter((p) => counts.has(p))
    .map((p) => `${counts.get(p)} ${PHASE_LABEL[p] ?? p}`)
    .join(' · ')
}

function VideoSetEditor({
  set,
  videos,
  studyId,
}: {
  set: VideoSet
  videos: AdminVideo[]
  studyId: number
}) {
  const update = useUpdateVideoSet(studyId)
  const del = useDeleteVideoSet(studyId)
  const toast = useToast()
  const [name, setName] = useState(set.name)
  const [items, setItems] = useState<Slot[]>([])
  const [pick, setPick] = useState('')
  // Both read inside the effect below, which must not depend on them.
  const dirtyRef = useRef(false)
  const seededFor = useRef<number | null>(null)

  useEffect(() => {
    // Any mutation on this page refetches every set, so re-seeding blindly
    // would throw away a reordering the researcher has not saved yet. The
    // first sight of a set still has to seed, though — before that the empty
    // form reads as unsaved work.
    if (seededFor.current === set.id && dirtyRef.current) return
    seededFor.current = set.id
    setName(set.name)
    setItems(
      set.items.map((s) => ({
        video_id: s.video_id,
        phase_type: s.phase_type,
        title: s.video_title,
      })),
    )
  }, [set])

  const saved = set.items.map((s) => s.video_id).join(',')
  const dirty = name.trim() !== set.name || items.map((s) => s.video_id).join(',') !== saved
  dirtyRef.current = dirty

  const add = () => {
    const v = videos.find((x) => x.id === Number(pick))
    // A clip may appear once in a run: everything a participant produces is
    // keyed by (participant, video), so a repeat would overwrite the first
    // showing rather than be a second case. The backend refuses it too.
    if (v && !items.some((it) => it.video_id === v.id)) {
      setItems([...items, { video_id: v.id, phase_type: v.phase_type, title: v.title }])
    }
    setPick('')
  }

  const move = (from: number, to: number) => {
    if (to < 0 || to >= items.length) return
    const next = [...items]
    const [moved] = next.splice(from, 1)
    next.splice(to, 0, moved)
    setItems(next)
  }

  const save = () =>
    update.mutate(
      {
        id: set.id,
        name: name.trim() || set.name,
        items: items.map((it, idx) => ({
          video_id: it.video_id,
          slot_index: idx,
          phase_type: it.phase_type,
        })),
      },
      {
        onSuccess: () => toast.show(`Set ${name.trim() || set.name} gespeichert.`, 'success'),
        onError: () => toast.show('Das Set konnte nicht gespeichert werden.', 'error'),
      },
    )

  const remove = () => {
    if (
      !window.confirm(
        `Set „${set.name}" löschen? Teilnehmer, die es bereits erhalten haben, behalten ihre Reihenfolge.`,
      )
    ) {
      return
    }
    del.mutate(set.id, {
      onError: () => toast.show('Das Set konnte nicht gelöscht werden.', 'error'),
    })
  }

  return (
    <div className="card">
      <div className="flex-between">
        <div className="inline-form">
          <h3 style={{ margin: 0 }}>Set</h3>
          <input
            className="input"
            style={{ maxWidth: 120 }}
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-label={`Name von Set ${set.name}`}
          />
          <span className={`pill ${set.participant_count ? 'pill--ok' : 'pill--idle'}`}>
            {set.participant_count} {set.participant_count === 1 ? 'Teilnehmer' : 'Teilnehmende'}
          </span>
        </div>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={remove}
          disabled={del.isPending}
        >
          Löschen
        </button>
      </div>

      <ol className="seq-list" aria-label={`Videos in Set ${set.name}`}>
        {items.map((it, i) => (
          <li key={`${it.video_id}-${i}`} className="seq-item">
            <span>
              {i + 1}. {it.title}{' '}
              <span className="muted">({PHASE_LABEL[it.phase_type] ?? it.phase_type})</span>
            </span>
            <span className="inline-form">
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => move(i, i - 1)}
                disabled={i === 0}
                aria-label={`${it.title} nach oben`}
              >
                ↑
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => move(i, i + 1)}
                disabled={i === items.length - 1}
                aria-label={`${it.title} nach unten`}
              >
                ↓
              </button>
              <button
                type="button"
                className="btn btn-ghost btn-sm"
                onClick={() => setItems(items.filter((_, idx) => idx !== i))}
              >
                Entfernen
              </button>
            </span>
          </li>
        ))}
        {items.length === 0 && (
          <li className="muted">Noch keine Videos — ein leeres Set wird niemandem zugeteilt.</li>
        )}
      </ol>
      {items.length > 0 && <p className="muted small">{phaseSummary(items)}</p>}

      <div className="inline-form">
        <select className="input" value={pick} onChange={(e) => setPick(e.target.value)}>
          <option value="">Video wählen…</option>
          {videos
            .filter((v) => !items.some((it) => it.video_id === v.id))
            .map((v) => (
              <option key={v.id} value={v.id}>
                {v.title} ({PHASE_LABEL[v.phase_type] ?? v.phase_type})
              </option>
            ))}
        </select>
        <button type="button" className="btn btn-secondary" onClick={add} disabled={!pick}>
          Hinzufügen
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={save}
          disabled={!dirty || update.isPending}
        >
          Speichern
        </button>
      </div>
      {set.participant_count > 0 && (
        <p className="muted small">
          Änderungen gelten nur für Teilnehmer, die sich danach zum ersten Mal anmelden; wer das Set
          schon erhalten hat, behält seine Reihenfolge.
        </p>
      )}
    </div>
  )
}
