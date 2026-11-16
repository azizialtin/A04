import { useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'

import type { Study, StudyTexts } from '../../api/admin'
import DeleteStudySection from '../../components/admin/DeleteStudySection'
import ExportsSection from '../../components/admin/ExportsSection'
import ParticipantsSection from '../../components/admin/ParticipantsSection'
import QuestionnairesSection from '../../components/admin/QuestionnairesSection'
import StatsSection from '../../components/admin/StatsSection'
import VideoSetsSection from '../../components/admin/VideoSetsSection'
import VideosSection from '../../components/admin/VideosSection'
import { useStudy, useUpdateStudy } from '../../hooks/admin'
import ThinkAloudSection from '../../components/admin/ThinkAloudSection'
import de from '../../i18n/locales/de.json'

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
  // The tab is in the URL so another screen can open one directly — the
  // participant list sends "Export" here with that person preselected.
  const [params, setParams] = useSearchParams()
  const tab = params.get('tab') ?? 'stats'
  const preselected = params.get('participant')
  const setTab = (key: string) => setParams({ tab: key }, { replace: true })

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
      {tab === 'export' && <ExportsSection studyId={id} preselected={preselected} />}
      {tab === 'details' && (
        <>
          <DetailsSection study={study.data} />
          <ThinkAloudSection study={study.data} />
          <TextsSection study={study.data} />
          <DeleteStudySection study={study.data} />
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
  const nameError =
    !name.trim() || name.trim().length > 255
      ? 'Bitte einen Namen mit 1 bis 255 Zeichen eingeben.'
      : ''
  const invalid = !!nameError || pre.length > 1000 || post.length > 1000 || idParam.length > 64

  return (
    <div className="card form">
      <h2>Details</h2>
      <div className="form-row">
        <label className="label" htmlFor="study-name">
          Name
        </label>
        <input
          id="study-name"
          maxLength={255}
          aria-invalid={!!nameError}
          className="input"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label">SoSci-Link (Vortest)</label>
        <input
          maxLength={1000}
          className="input"
          value={pre}
          onChange={(e) => setPre(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label">SoSci-Link (Nachtest)</label>
        <input
          maxLength={1000}
          className="input"
          value={post}
          onChange={(e) => setPost(e.target.value)}
        />
      </div>
      <div className="form-row">
        <label className="label">ID-Parameter</label>
        <input
          maxLength={64}
          className="input"
          value={idParam}
          onChange={(e) => setIdParam(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={update.isPending || invalid}
        onClick={() =>
          update.mutate({
            name: name.trim(),
            sosci_pretest_url: pre,
            sosci_posttest_url: post,
            sosci_id_param: idParam,
          })
        }
      >
        Speichern
      </button>
      {nameError && (
        <p className="error-text" role="alert">
          {nameError}
        </p>
      )}
      {update.isError && (
        <p className="error-text" role="alert">
          Speichern fehlgeschlagen. Bitte Eingaben prüfen und erneut versuchen.
        </p>
      )}
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
  case_outro_title: 'Fall abgeschlossen',
  case_outro_body: 'Danke. Bitte beantworten Sie noch einige kurze Fragen zu diesem Fall.',
  think_aloud_title: 'Lautes Denken',
  think_aloud_body:
    'Sehen Sie sich die Aufzeichnung an und erläutern Sie der Studienleitung, worauf Sie geachtet haben und warum Sie Ihre Notizen zu diesem Zeitpunkt gemacht haben.',
}

/**
 * The participant-facing wording a study may rewrite: the welcome page and the
 * short page before each case. Each field left empty keeps the app's own text,
 * so a study can rewrite just the introduction; what is written here shows in
 * both interface languages, like the rest of the instrument.
 */
function TextsSection({ study }: { study: Study }) {
  const pilot = study.flow_version === 'pilot_20261116'
  const defaults = pilot
    ? {
        ...TEXT_DEFAULTS,
        welcome_intro: de.pilot.welcome_intro,
        case_intro_title: de.pilot.case_intro_title,
        case_intro_body: de.pilot.case_intro_body,
        case_outro_body: de.pilot.case_outro_body,
      }
    : TEXT_DEFAULTS
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
      pre_test_case_intro_title: '',
      pre_test_case_intro_body: '',
      case_outro_title: '',
      case_outro_body: '',
      think_aloud_title: '',
      think_aloud_body: '',
      ...Object.fromEntries(
        Object.keys(de.pilot.text_pages).flatMap((key) => [
          [`${key}_title`, ''],
          [`${key}_body`, ''],
        ]),
      ),
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
          placeholder={defaults.welcome_title}
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
          placeholder={defaults.welcome_intro}
          onChange={set('welcome_intro')}
        />
      </div>
      {!pilot && (
        <>
          <div className="form-row">
            <label className="label" htmlFor="welcome-steps">
              „Der Ablauf" (ein Schritt pro Zeile)
            </label>
            <textarea
              id="welcome-steps"
              className="textarea"
              value={steps}
              placeholder={defaults.welcome_steps.join('\n')}
              onChange={(e) => setSteps(e.target.value)}
            />
          </div>
        </>
      )}
      <div className="form-row">
        <label className="label" htmlFor="welcome-note">
          Hinweis unter der Teilnehmer-ID
        </label>
        <input
          id="welcome-note"
          className="input"
          value={texts.welcome_note}
          placeholder={defaults.welcome_note}
          onChange={set('welcome_note')}
        />
      </div>

      <h3>Vor jedem Fall</h3>
      <p className="muted small">Die kurze Seite zwischen den Fällen, vor jedem Video.</p>
      {pilot ? (
        <p className="muted small">
          Die Überschrift „Fall x“ verwendet automatisch die fortlaufende Fallnummer.
        </p>
      ) : (
        <>
          <div className="form-row">
            <label className="label" htmlFor="case-intro-title">
              Überschrift
            </label>
            <input
              id="case-intro-title"
              className="input"
              value={texts.case_intro_title}
              placeholder={defaults.case_intro_title}
              onChange={set('case_intro_title')}
            />
          </div>
        </>
      )}
      <div className="form-row">
        <label className="label" htmlFor="case-intro-body">
          Text (Absätze durch eine Leerzeile trennen)
        </label>
        <textarea
          id="case-intro-body"
          className="textarea"
          value={texts.case_intro_body}
          placeholder={defaults.case_intro_body}
          onChange={set('case_intro_body')}
        />
      </div>

      {!pilot && (
        <>
          <h3>Vor dem Vortest-Video</h3>
          <p className="muted small">Leer übernimmt den Text „Vor jedem Fall“.</p>
          <div className="form-row">
            <label className="label" htmlFor="pretest-case-title">
              Überschrift für das Vortest-Video
            </label>
            <input
              id="pretest-case-title"
              className="input"
              value={texts.pre_test_case_intro_title ?? ''}
              onChange={set('pre_test_case_intro_title')}
            />
          </div>
          <div className="form-row">
            <label className="label" htmlFor="pretest-case-body">
              Einleitung für das Vortest-Video
            </label>
            <textarea
              id="pretest-case-body"
              className="textarea"
              value={texts.pre_test_case_intro_body ?? ''}
              onChange={set('pre_test_case_intro_body')}
            />
          </div>
        </>
      )}
      <h3>Nach jedem Fall</h3>
      <p className="muted small">
        Die Seite „Fall abgeschlossen“ mit den kurzen Fragen zum Fall; die Fragen selbst stehen
        unter „Fragebögen“.
      </p>
      <div className="form-row">
        <label className="label" htmlFor="case-outro-title">
          Überschrift
        </label>
        <input
          id="case-outro-title"
          className="input"
          value={texts.case_outro_title}
          placeholder={defaults.case_outro_title}
          onChange={set('case_outro_title')}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="case-outro-body">
          Text (Absätze durch eine Leerzeile trennen)
        </label>
        <textarea
          id="case-outro-body"
          className="textarea"
          value={texts.case_outro_body}
          placeholder={defaults.case_outro_body}
          onChange={set('case_outro_body')}
        />
      </div>

      {pilot &&
        Object.entries(de.pilot.text_pages).map(([key, text]) => {
          const label = key === 'post_intro' ? 'Vor dem Abschlussfragebogen' : text.title
          const titleKey = `${key}_title` as keyof StudyTexts
          const bodyKey = `${key}_body` as keyof StudyTexts
          return (
            <fieldset className="form" key={key}>
              <legend>{label}</legend>
              <label className="label" htmlFor={`text-${key}-title`}>
                Überschrift: {label}
              </label>
              <input
                id={`text-${key}-title`}
                className="input"
                maxLength={200}
                value={(texts[titleKey] as string | undefined) ?? ''}
                placeholder={text.title || 'Keine Überschrift (Standard)'}
                onChange={set(titleKey)}
              />
              <label className="label" htmlFor={`text-${key}-body`}>
                Text: {label}
              </label>
              <textarea
                id={`text-${key}-body`}
                className="textarea"
                maxLength={8000}
                style={{ minHeight: key === 'video_intro' ? 240 : 120 }}
                value={(texts[bodyKey] as string | undefined) ?? ''}
                placeholder={text.body}
                onChange={set(bodyKey)}
              />
              {key === 'post_intro' && (
                <p className="muted small">
                  Standardmäßig erscheint diese Seite ohne Überschrift. Leeren Sie das
                  Überschriftfeld, um diesen Standard wiederherzustellen.
                </p>
              )}
              {(key === 'video_end' || key === 'discussion_start') && (
                <p className="muted small">
                  Diese Pausenseite erscheint beim gebündelten lauten Denken nach dem Nachtest.
                </p>
              )}
            </fieldset>
          )
        })}

      <h3>Lautes Denken</h3>
      <p className="muted small">
        Die Überschrift wird in einem Block aus mehreren Aufzeichnungen um „1 von 3“ ergänzt.
      </p>
      <div className="form-row">
        <label className="label" htmlFor="think-aloud-title">
          Überschrift
        </label>
        <input
          id="think-aloud-title"
          className="input"
          value={texts.think_aloud_title}
          placeholder={defaults.think_aloud_title}
          onChange={set('think_aloud_title')}
        />
      </div>
      <div className="form-row">
        <label className="label" htmlFor="think-aloud-body">
          Hinweis (Absätze durch eine Leerzeile trennen)
        </label>
        <textarea
          id="think-aloud-body"
          className="textarea"
          value={texts.think_aloud_body}
          placeholder={defaults.think_aloud_body}
          onChange={set('think_aloud_body')}
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
