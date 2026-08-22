import { useRef, useState, type FormEvent } from 'react'

import { useDeleteVideo, useUploadVideo, useVideos } from '../../hooks/admin'
import { useToast } from '../Toast'

const PHASES = [
  ['pre_test', 'Vortest'],
  ['training', 'Training'],
  ['post_test', 'Nachtest'],
] as const

export default function VideosSection({ studyId }: { studyId: number }) {
  const videos = useVideos(studyId)
  const upload = useUploadVideo(studyId)
  const del = useDeleteVideo(studyId)
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const [title, setTitle] = useState('')
  const [phase, setPhase] = useState('training')
  const [task, setTask] = useState('')
  const [info, setInfo] = useState('')
  const [studentTask, setStudentTask] = useState('')
  const [limit, setLimit] = useState('')
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState('')

  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !file) {
      setErr('Titel und Videodatei sind erforderlich.')
      return
    }
    setErr('')
    upload.mutate(
      {
        title: title.trim(),
        phase_type: phase,
        task_description: task,
        info_text: info,
        student_task_text: studentTask,
        time_limit_seconds: limit.trim() ? Number(limit.trim()) : null,
        file,
      },
      {
        onSuccess: () => {
          setTitle('')
          setTask('')
          setInfo('')
          setStudentTask('')
          setLimit('')
          setFile(null)
          if (fileRef.current) fileRef.current.value = ''
        },
      },
    )
  }

  return (
    <div>
      <form className="card form" onSubmit={submit}>
        <h2>Video hochladen</h2>
        <div className="form-row">
          <label className="label">Titel</label>
          <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">Phase</label>
          <select className="input" value={phase} onChange={(e) => setPhase(e.target.value)}>
            {PHASES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>
        <div className="form-row">
          <label className="label">Aufgabe (Task)</label>
          <textarea className="textarea" value={task} onChange={(e) => setTask(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">Info-Text</label>
          <textarea className="textarea" value={info} onChange={(e) => setInfo(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">Schüler-Aufgabe</label>
          <textarea className="textarea" value={studentTask} onChange={(e) => setStudentTask(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">Zeitlimit (Sekunden, optional)</label>
          <input className="input" type="number" value={limit} onChange={(e) => setLimit(e.target.value)} />
        </div>
        <div className="form-row">
          <label className="label">Videodatei</label>
          <input ref={fileRef} type="file" accept="video/*" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        {err && <p className="error-text">{err}</p>}
        {upload.isError && (
          <p className="error-text">
            Upload fehlgeschlagen. Erlaubt sind .mp4, .m4v, .mov und .webm bis 500 MB.
          </p>
        )}
        {upload.progress !== null && (
          <div className="progress" role="progressbar" aria-valuenow={upload.progress}>
            <div style={{ width: `${upload.progress}%` }} />
            <span>{upload.progress}%</span>
          </div>
        )}
        <button className="btn btn-primary" type="submit" disabled={upload.isPending}>
          {upload.isPending ? 'Wird hochgeladen…' : 'Hochladen'}
        </button>
      </form>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Titel</th>
            <th>Phase</th>
            <th>Limit</th>
            <th>Datei</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {(videos.data ?? []).map((v) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td>{v.title}</td>
              <td>{v.phase_type}</td>
              <td>{v.time_limit_seconds ?? '—'}</td>
              <td>{v.has_file ? '✓' : '—'}</td>
              <td>
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  onClick={() => {
                    // Deleting a video now takes its file and any gaze
                    // recordings of it with it, so ask first.
                    if (
                      !window.confirm(
                        `„${v.title}" endgültig löschen? Die Videodatei und alle Blickaufzeichnungen dazu werden mitgelöscht.`,
                      )
                    ) {
                      return
                    }
                    del.mutate(v.id, {
                      onError: () => toast.show('Video wird in einer Sequenz verwendet.', 'error'),
                    })
                  }}
                >
                  Löschen
                </button>
              </td>
            </tr>
          ))}
          {videos.data?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Noch keine Videos.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}
