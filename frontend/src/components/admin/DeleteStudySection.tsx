import type { AxiosError } from 'axios'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'

import type { Study } from '../../api/admin'
import { useDeleteStudy, useStudyStats, useVideos } from '../../hooks/admin'
import Modal from '../Modal'
import { useToast } from '../Toast'

/**
 * The one irreversible thing an admin can do to a study. Every admin is equal
 * here — there are no roles — so the protection is the dialog: it spells out
 * what goes with the study, in numbers, and the name has to be typed before
 * the red button works.
 */
export default function DeleteStudySection({ study }: { study: Study }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="card card--danger">
      <h2>Studie löschen</h2>
      <p className="muted">
        Entfernt die Studie samt Teilnehmern, Videos, Fragebögen, Antworten, Notizen, Diagnosen,
        Ereignissen, Blickdaten und Bildschirmaufnahmen – endgültig und für alle Admins. Exportieren
        Sie vorher, was Sie behalten wollen.
      </p>
      <button type="button" className="btn btn-danger" onClick={() => setOpen(true)}>
        Studie löschen…
      </button>
      {open && <DeleteStudyDialog study={study} onClose={() => setOpen(false)} />}
    </div>
  )
}

function DeleteStudyDialog({ study, onClose }: { study: Study; onClose: () => void }) {
  const stats = useStudyStats(study.id)
  const videos = useVideos(study.id)
  const remove = useDeleteStudy()
  const navigate = useNavigate()
  const toast = useToast()
  const [typed, setTyped] = useState('')
  const confirmed = typed.trim() === study.name.trim()

  const counts = stats.data
  const lines = counts
    ? [
        `${counts.participants.total} Teilnehmer, davon ${counts.participants.started} mit begonnenem Durchlauf`,
        `${videos.data?.length ?? 0} Videos samt Dateien`,
        `${counts.data.responses} Fragebogen-Antworten, ${counts.data.notes} Notizen, ${counts.data.diagnoses} Diagnosen`,
        `${counts.data.gaze_recordings} Blickaufzeichnungen und ${counts.data.screens_stored} Bildschirmaufnahmen`,
      ]
    : null

  const destroy = () =>
    remove.mutate(
      { id: study.id, force: true },
      {
        onSuccess: () => {
          toast.show(`Studie „${study.name}“ gelöscht.`, 'success')
          navigate('/admin/studies', { replace: true })
        },
      },
    )

  return (
    <Modal open title="Studie löschen" onClose={onClose}>
      <p>
        Sie löschen die Studie <strong>{study.name}</strong>. Das lässt sich nicht rückgängig
        machen.
      </p>
      <p className="muted small">Mit ihr verschwinden:</p>
      {lines ? (
        <ul className="prose-list">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : (
        <p className="muted small">
          {stats.isError ? 'Zählung nicht verfügbar.' : 'Wird gezählt…'}
        </p>
      )}
      <div className="form-row">
        <label className="label" htmlFor="delete-study-name">
          Geben Sie zur Bestätigung den Namen der Studie ein
        </label>
        <input
          id="delete-study-name"
          className="input"
          value={typed}
          placeholder={study.name}
          autoComplete="off"
          autoFocus
          onChange={(e) => setTyped(e.target.value)}
        />
      </div>
      {remove.isError && (
        <p className="error-text">
          Die Studie konnte nicht gelöscht werden. {detail(remove.error)}
        </p>
      )}
      <div className="modal__actions">
        <button type="button" className="btn btn-secondary" onClick={onClose}>
          Abbrechen
        </button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={!confirmed || remove.isPending}
          onClick={destroy}
        >
          {remove.isPending ? 'Wird gelöscht…' : 'Endgültig löschen'}
        </button>
      </div>
    </Modal>
  )
}

function detail(error: unknown): string {
  const data = (error as AxiosError<{ detail?: unknown }>)?.response?.data
  return typeof data?.detail === 'string' ? data.detail : ''
}
