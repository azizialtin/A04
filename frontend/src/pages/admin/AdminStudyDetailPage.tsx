import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type { Study, StudyTexts } from '../../api/admin'
import ExportsSection from '../../components/admin/ExportsSection'
import ParticipantsSection from '../../components/admin/ParticipantsSection'
import QuestionnairesSection from '../../components/admin/QuestionnairesSection'
import StatsSection from '../../components/admin/StatsSection'
import VideoSetsSection from '../../components/admin/VideoSetsSection'
import VideosSection from '../../components/admin/VideosSection'
import { useStudy, useUpdateStudy, useVideos } from '../../hooks/admin'
import { thinkAloudBlocks } from '../../lib/thinkAloud'

const TABS = [
  ['stats', 'Statistik'],
  ['videos', 'Videos'],
  ['sets', 'Videosets'],
  ['participants', 'Teilnehmer'],
  ['questionnaires', 'Fragebögen'],
  ['export', 'Export'],
  ['details', 'Details'],
] as const

export default function AdminStudyDetailPage() {
  const { studyId } = useParams()
  const id = Number(studyId)
  const study = useStudy(id)
  const [tab, setTab] = useState<string>('stats')

  if (study.isLoading) return <p className="muted">Wird geladen…</p>
  if (study.isError || !study.data) return <p className="error-text">Studie nicht gefunden.</p>

  return (
    <div>
      <Link to="/admin/studies" className="muted">
        ← Studien
      </Link>
      <h1>{study.data.name}</h1>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button
            key={key}
            type="button"
            className={tab === key ? 'is-active' : ''}
            onClick={() => setTab(key)}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === 'stats' && <StatsSection studyId={id} />}
      {tab === 'videos' && <VideosSection studyId={id} />}
      {tab === 'sets' && <VideoSetsSection studyId={id} />}
      {tab === 'participants' && <ParticipantsSection studyId={id} />}
      {tab === 'questionnaires' && <QuestionnairesSection studyId={id} />}
      {tab === 'export' && <ExportsSection studyId={id} />}
      {tab === 'details' && (
        <>
          <DetailsSection study={study.data} />
          <ThinkAloudSection study={study.data} />
          <TextsSection study={study.data} />
        </>
      )}
    </div>
  )
}

function DetailsSection({ study }: { study: Study }) {
  const update = useUpdateStudy(study.id)
  const [name, setName] = useState(study.name)
  const [pre, setPre] = useState(study.sosci_pretest_url)
  const [post, setPost] = useState(study.sosci_posttest_url)
  const [idParam, setIdParam] = useState(study.sosci_id_param)

  return (
    <div className="card form">
      <h2>Details</h2>
      <div className="form-row">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">SoSci-Link (Vortest)</label>
        <input className="input" value={pre} onChange={(e) => setPre(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">SoSci-Link (Nachtest)</label>
        <input className="input" value={post} onChange={(e) => setPost(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">ID-Parameter</label>
        <input className="input" value={idParam} onChange={(e) => setIdParam(e.target.value)} />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={update.isPending}
        onClick={() =>
          update.mutate({
            name,
            sosci_pretest_url: pre,
            sosci_posttest_url: post,
            sosci_id_param: idParam,
          })
        }
      >
        Speichern
      </button>
      {update.isSuccess && (
        <span className="muted" style={{ marginLeft: 12 }}>
          Gespeichert.
        </span>
      )}
    </div>
  )
}

// What the participant sees when nothing is written here — shown as the
// placeholder of each field, so the default is visible and easy to start from.
const TEXT_DEFAULTS = {
  welcome_title: 'Willkommen',
  welcome_intro:
    'Schön, dass Sie dabei sind. Bitte lesen Sie zunächst die Informationen zum Ablauf und zum Fragebogen auf SoSciSurvey und arbeiten Sie sich dann Schritt für Schritt durch die Studie. In den Fällen sehen Sie kurze Videos, in denen Schülerinnen und Schüler mit fehlerhaftem Programmcode arbeiten; Ihre Aufgabe ist es, das jeweilige Problem zu erkennen.',
  welcome_steps: [
    'Einige Fragen zu Ihrer Person und zu Ihren Vorkenntnissen',
    'Der Fragebogen auf SoSciSurvey – er öffnet sich in einem neuen Tab, Ihre Teilnehmer-ID wird automatisch übergeben',
    'Neun Fälle, jeweils mit Video, schriftlicher Diagnose und lautem Denken',
  ],
  welcome_note:
    'Bitte merken Sie sich diese ID – Sie benötigen sie für die Fragebögen und um später fortzufahren.',
  case_intro_title: 'Neuer Fall',
  case_intro_body:
    'Gleich sehen Sie ein neues Video. Beobachten Sie aufmerksam und machen Sie sich während des Ansehens Notizen.',
}

/**
 * The participant-facing wording a study may rewrite: the welcome page and the
 * short page before each case. Each field left empty keeps the app's own text,
 * so a study can rewrite just the introduction; what is written here shows in
 * both interface languages, like the rest of the instrument.
 */
function TextsSection({ study }: { study: Study }) {
  const update = useUpdateStudy(study.id)
  const [texts, setTexts] = useState<StudyTexts>(study.texts)
  const [steps, setSteps] = useState(study.texts.welcome_steps.join('\n'))

  const set = (key: keyof StudyTexts) => (e: { target: { value: string } }) =>
    setTexts({ ...texts, [key]: e.target.value })

  const save = () =>
    update.mutate({
      texts: {
        ...texts,
        welcome_steps: steps
          .split('\n')
          .map((s) => s.trim())
          .filter(Boolean),
      },
    })

  const reset = () => {
    setTexts({
      welcome_title: '',
      welcome_intro: '',
      welcome_steps: [],
      welcome_note: '',
      case_intro_title: '',
      case_intro_body: '',
    })
    setSteps('')
  }

  return (
    <div className="card form" style={{ marginTop: 16 }}>
      <h2>Texte für Teilnehmer</h2>
      <p className="muted">
        Leere Felder zeigen den Standardtext (hier als Platzhalter zu sehen). Die Texte gelten in
        beiden Sprachen der Oberfläche; Teilnehmer-ID und Weiter-Buttons bleiben immer erhalten.
      </p>

      <h3>Willkommensseite</h3>
      <div className="form-row">
        <label className="label" htmlFor="welcome-title">
          Überschrift
        </label>
        <input
          id="welcome-title"
          className="input"
          value={texts.welcome_title}
          placeholder={TEXT_DEFAULTS.welcome_title}
          onChange={set('welcome_title')}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="welcome-intro">
          Einleitung (Absätze durch eine Leerzeile trennen)
        </label>
        <textarea
          id="welcome-intro"
          className="textarea"
          style={{ minHeight: 140 }}
          value={texts.welcome_intro}
          placeholder={TEXT_DEFAULTS.welcome_intro}
          onChange={set('welcome_intro')}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="welcome-steps">
          „Der Ablauf" (ein Schritt pro Zeile)
        </label>
        <textarea
          id="welcome-steps"
          className="textarea"
          value={steps}
          placeholder={TEXT_DEFAULTS.welcome_steps.join('\n')}
          onChange={(e) => setSteps(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="welcome-note">
          Hinweis unter der Teilnehmer-ID
        </label>
        <input
          id="welcome-note"
          className="input"
          value={texts.welcome_note}
          placeholder={TEXT_DEFAULTS.welcome_note}
          onChange={set('welcome_note')}
        />
      </div>

      <h3>Vor jedem Fall</h3>
      <p className="muted small">Die kurze Seite zwischen den Fällen, vor jedem Video.</p>
      <div className="form-row">
        <label className="label" htmlFor="case-intro-title">
          Überschrift
        </label>
        <input
          id="case-intro-title"
          className="input"
          value={texts.case_intro_title}
          placeholder={TEXT_DEFAULTS.case_intro_title}
          onChange={set('case_intro_title')}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="case-intro-body">
          Text (Absätze durch eine Leerzeile trennen)
        </label>
        <textarea
          id="case-intro-body"
          className="textarea"
          value={texts.case_intro_body}
          placeholder={TEXT_DEFAULTS.case_intro_body}
          onChange={set('case_intro_body')}
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
        <button type="button" className="btn btn-ghost" onClick={reset}>
          Auf Standardtexte zurücksetzen
        </button>
        {update.isSuccess && <span className="muted">Gespeichert.</span>}
        {update.isError && <span className="error-text">Konnte nicht gespeichert werden.</span>}
      </div>
    </div>
  )
}

/**
 * How many training cases run before their think-aloud screens. One — the
 * default — is a think-aloud straight after each case, which is how the study
 * was originally designed; a larger block delays them all to the end of the
 * block. The pre-test and post-test case are never batched.
 */
function ThinkAloudSection({ study }: { study: Study }) {
  const update = useUpdateStudy(study.id)
  const videos = useVideos(study.id)
  const [size, setSize] = useState(String(study.think_aloud_batch_size))

  const chosen = Number(size)
  const valid = Number.isInteger(chosen) && chosen >= 1 && chosen <= 20
  const training = (videos.data ?? []).filter((v) => v.phase_type === 'training').length
  const blocks = thinkAloudBlocks(training, valid ? chosen : 1)

  return (
    <div className="card form" style={{ marginTop: 16 }}>
      <h2>Lautes Denken</h2>
      <p className="muted">
        Wie viele Trainingsfälle bearbeitet werden, bevor das laute Denken dazu kommt. Bei 1 folgt
        es direkt auf jeden Fall; bei 3 werden erst drei Fälle bearbeitet und danach die drei
        Aufzeichnungen nacheinander gezeigt. Vor- und Nachtest sind davon ausgenommen – dort folgt
        das laute Denken immer unmittelbar auf den Fall.
      </p>
      <div className="form-row">
        <label className="label" htmlFor="think-aloud-batch">
          Fälle pro Block (1–20)
        </label>
        <input
          id="think-aloud-batch"
          className="input"
          type="number"
          min={1}
          max={20}
          value={size}
          onChange={(e) => setSize(e.target.value)}
          style={{ maxWidth: 160 }}
        />
      </div>

      {training > 0 && valid && (
        <p className="muted small">
          {blocks.length === 1 && blocks[0] === 1
            ? `Bei ${training} Trainingsvideos: nach jedem Fall ein lautes Denken.`
            : `Bei ${training} Trainingsvideos: ${blocks
                .map((n) => `${n} ${n === 1 ? 'Fall' : 'Fälle'} → ${n}× lautes Denken`)
                .join(' · ')}`}
        </p>
      )}
      {!valid && <p className="error-text">Bitte eine Zahl zwischen 1 und 20 eintragen.</p>}

      <div className="inline-form">
        <button
          type="button"
          className="btn btn-primary"
          disabled={!valid || update.isPending}
          onClick={() => update.mutate({ think_aloud_batch_size: chosen })}
        >
          Speichern
        </button>
        {update.isSuccess && <span className="muted">Gespeichert.</span>}
        {update.isError && <span className="error-text">Konnte nicht gespeichert werden.</span>}
      </div>
      <p className="muted small">
        Gilt für Teilnehmer, die sich danach zum ersten Mal anmelden. Wer bereits begonnen hat,
        behält den Ablauf, mit dem er gestartet ist.
      </p>
    </div>
  )
}
