import { useEffect, useRef, useState, type FormEvent } from 'react'

import type { Study, StudyVideoDefaults } from '../../api/admin'
import {
  useDeleteVideo,
  useStudy,
  useUpdateStudy,
  useUploadVideo,
  useVideos,
} from '../../hooks/admin'
import { useToast } from '../Toast'

const PHASES = [
  ['pre_test', 'Vortest'],
  ['training', 'Training'],
  ['post_test', 'Nachtest'],
] as const

export default function VideosSection({ studyId }: { studyId: number }) {
  const study = useStudy(studyId)
  const videos = useVideos(studyId)
  const upload = useUploadVideo(studyId)
  const del = useDeleteVideo(studyId)
  const toast = useToast()
  const fileRef = useRef<HTMLInputElement>(null)

  const defaults = study.data?.video_defaults

  const [title, setTitle] = useState('')
  const [phase, setPhase] = useState('training')
  const [task, setTask] = useState('')
  const [info, setInfo] = useState('')
  const [studentTask, setStudentTask] = useState('')
  const [limit, setLimit] = useState('')
  const [useDefaultTask, setUseDefaultTask] = useState(false)
  const [useDefaultInfo, setUseDefaultInfo] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [err, setErr] = useState('')
  // What the researcher has decided for this clip. Until they touch a control
  // it follows the study's default, including when that default changes —
  // after, it is theirs. Editing the defaults card above refetches the study,
  // so without this a saved default would re-tick a box they had just cleared
  // and the clip would go up showing the wrong text.
  const limitTouched = useRef(false)
  const taskChoiceTouched = useRef(false)
  const infoChoiceTouched = useRef(false)

  useEffect(() => {
    if (!defaults) return
    if (!limitTouched.current) {
      setLimit(defaults.time_limit_seconds != null ? String(defaults.time_limit_seconds) : '')
    }
    // A default text that exists is worth following; the box is still theirs.
    if (!taskChoiceTouched.current) setUseDefaultTask(!!defaults.task_description)
    if (!infoChoiceTouched.current) setUseDefaultInfo(!!defaults.info_text)
  }, [defaults])

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
        task_description: useDefaultTask ? '' : task,
        info_text: useDefaultInfo ? '' : info,
        student_task_text: studentTask,
        time_limit_seconds: limit.trim() ? Number(limit.trim()) : null,
        use_default_task: useDefaultTask,
        use_default_info: useDefaultInfo,
        file,
      },
      {
        onSuccess: () => {
          setTitle('')
          setTask('')
          setInfo('')
          setStudentTask('')
          setFile(null)
          if (fileRef.current) fileRef.current.value = ''
          // The next clip starts from the defaults again, in full.
          limitTouched.current = false
          taskChoiceTouched.current = false
          infoChoiceTouched.current = false
          setLimit(defaults?.time_limit_seconds != null ? String(defaults.time_limit_seconds) : '')
          setUseDefaultTask(!!defaults?.task_description)
          setUseDefaultInfo(!!defaults?.info_text)
        },
      },
    )
  }

  return (
    <div>
      {study.data && <VideoDefaultsCard study={study.data} />}

      <form className="card form" onSubmit={submit}>
        <h2>Video hochladen</h2>
        <div className="form-row">
          <label className="label" htmlFor="video-title">
            Titel
          </label>
          <input
            id="video-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="video-phase">
            Phase
          </label>
          <select
            id="video-phase"
            className="input"
            value={phase}
            onChange={(e) => setPhase(e.target.value)}
          >
            {PHASES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </div>

        <DefaultableText
          id="video-task"
          label="Aufgabe (Task)"
          value={task}
          onChange={setTask}
          useDefault={useDefaultTask}
          onUseDefault={(v) => {
            taskChoiceTouched.current = true
            setUseDefaultTask(v)
          }}
          defaultText={defaults?.task_description ?? ''}
        />
        <DefaultableText
          id="video-info"
          label="Info-Text"
          value={info}
          onChange={setInfo}
          useDefault={useDefaultInfo}
          onUseDefault={(v) => {
            infoChoiceTouched.current = true
            setUseDefaultInfo(v)
          }}
          defaultText={defaults?.info_text ?? ''}
        />

        <div className="form-row">
          <label className="label" htmlFor="video-student-task">
            Schüler-Aufgabe
          </label>
          <textarea
            id="video-student-task"
            className="textarea"
            value={studentTask}
            onChange={(e) => setStudentTask(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="video-limit">
            Zeitlimit (Sekunden, optional)
          </label>
          <input
            id="video-limit"
            className="input"
            type="number"
            value={limit}
            onChange={(e) => {
              limitTouched.current = true
              setLimit(e.target.value)
            }}
          />
          {defaults?.time_limit_seconds != null && (
            <p className="muted small">
              Vorbelegt mit dem Standard der Studie ({defaults.time_limit_seconds} s); pro Video
              änderbar.
            </p>
          )}
        </div>
        <div className="form-row">
          <label className="label" htmlFor="video-file">
            Videodatei
          </label>
          <input
            id="video-file"
            ref={fileRef}
            type="file"
            accept="video/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
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
            <th>Texte</th>
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
              <td className="muted small">
                {[
                  v.use_default_task ? 'Aufgabe: Standard' : null,
                  v.use_default_info ? 'Info: Standard' : null,
                ]
                  .filter(Boolean)
                  .join(' · ') || 'eigene'}
              </td>
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
                      onError: () =>
                        toast.show(
                          'Video wird in einer Sequenz oder einem Set verwendet.',
                          'error',
                        ),
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
              <td colSpan={7} className="muted">
                Noch keine Videos.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

/**
 * A text field that can defer to the study's default instead. Ticked, the
 * video stores nothing of its own and shows whatever the default says — now
 * and after the default is edited; the field turns into a read-only preview
 * so what will be shown is never a guess.
 */
function DefaultableText({
  id,
  label,
  value,
  onChange,
  useDefault,
  onUseDefault,
  defaultText,
}: {
  id: string
  label: string
  value: string
  onChange: (v: string) => void
  useDefault: boolean
  onUseDefault: (v: boolean) => void
  defaultText: string
}) {
  return (
    <div className="form-row">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <label className="checkbox-row">
        <input
          type="checkbox"
          checked={useDefault}
          onChange={(e) => onUseDefault(e.target.checked)}
        />
        <span>
          Standardtext der Studie verwenden
          {!defaultText && useDefault && (
            <span className="warn-text"> – für die Studie ist noch keiner hinterlegt</span>
          )}
        </span>
      </label>
      <textarea
        id={id}
        className="textarea"
        value={useDefault ? defaultText : value}
        readOnly={useDefault}
        aria-readonly={useDefault}
        placeholder={useDefault ? 'Kein Standardtext hinterlegt.' : undefined}
        onChange={(e) => onChange(e.target.value)}
        style={useDefault ? { background: 'var(--bg)', color: 'var(--muted)' } : undefined}
      />
    </div>
  )
}

/** The study's defaults for new videos, edited here where they are used. */
function VideoDefaultsCard({ study }: { study: Study }) {
  const update = useUpdateStudy(study.id)
  const [open, setOpen] = useState(false)
  const [limit, setLimit] = useState(
    study.video_defaults.time_limit_seconds != null
      ? String(study.video_defaults.time_limit_seconds)
      : '',
  )
  const [task, setTask] = useState(study.video_defaults.task_description)
  const [info, setInfo] = useState(study.video_defaults.info_text)

  const save = () => {
    const video_defaults: StudyVideoDefaults = {
      time_limit_seconds: limit.trim() ? Number(limit.trim()) : null,
      task_description: task,
      info_text: info,
    }
    update.mutate({ video_defaults })
  }

  const summary = [
    study.video_defaults.time_limit_seconds != null
      ? `${study.video_defaults.time_limit_seconds} s`
      : 'kein Zeitlimit',
    study.video_defaults.task_description ? 'Aufgabe hinterlegt' : 'keine Aufgabe',
    study.video_defaults.info_text ? 'Info-Text hinterlegt' : 'kein Info-Text',
  ].join(' · ')

  return (
    <div className="card form">
      <div className="flex-between">
        <div>
          <h2 style={{ marginBottom: 4 }}>Standardwerte für Videos</h2>
          <p className="muted small" style={{ margin: 0 }}>
            {summary}
          </p>
        </div>
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => setOpen(!open)}>
          {open ? 'Zuklappen' : 'Bearbeiten'}
        </button>
      </div>
      {open && (
        <>
          <p className="muted" style={{ marginTop: 12 }}>
            Das Zeitlimit wird beim Hochladen in jedes neue Video übernommen und lässt sich dort
            ändern. Aufgabe und Info-Text bleiben Texte der Studie: Videos, die beim Hochladen „
            Standardtext verwenden" angehakt haben, zeigen immer den aktuellen Stand von hier – eine
            Änderung wirkt also auf alle diese Videos zugleich.
          </p>
          <div className="form-row">
            <label className="label" htmlFor="default-limit">
              Zeitlimit (Sekunden, leer = kein Timer)
            </label>
            <input
              id="default-limit"
              className="input"
              type="number"
              value={limit}
              onChange={(e) => setLimit(e.target.value)}
              style={{ maxWidth: 200 }}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="default-task">
              Aufgabe (Task)
            </label>
            <textarea
              id="default-task"
              className="textarea"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="default-info">
              Info-Text
            </label>
            <textarea
              id="default-info"
              className="textarea"
              value={info}
              onChange={(e) => setInfo(e.target.value)}
            />
          </div>
          <div className="inline-form">
            <button
              type="button"
              className="btn btn-primary"
              disabled={update.isPending}
              onClick={save}
            >
              Speichern
            </button>
            {update.isSuccess && <span className="muted">Gespeichert.</span>}
            {update.isError && <span className="error-text">Konnte nicht gespeichert werden.</span>}
          </div>
        </>
      )}
    </div>
  )
}
