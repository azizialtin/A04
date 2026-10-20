import { useMemo, useState } from 'react'

import type { AxiosError } from 'axios'

import type { AdminQuestionnaire } from '../../api/admin'
import {
  useCreateQuestionnaire,
  useDeleteQuestionnaire,
  useQuestionnaires,
  useSeedQuestionnaires,
  useUpdateQuestionnaire,
} from '../../hooks/admin'
import type { Question } from '../../lib/questionnaire'
import { codeLines } from '../../lib/code'
import QuestionnaireRenderer from '../session/QuestionnaireRenderer'

const PLACEMENTS = [
  ['pre_test', 'Vortest (eigene Seite, einmal pro Durchlauf)'],
  ['diagnosis', 'Auf der Diagnose-Seite (nur einmal pro Studie)'],
  ['case_outro', 'Nach dem Fall (nur einmal pro Studie)'],
] as const

const SCALE_6 = [
  { value: 1, label: 'trifft überhaupt nicht zu' },
  { value: 2, label: 'trifft nicht zu' },
  { value: 3, label: 'trifft eher nicht zu' },
  { value: 4, label: 'trifft eher zu' },
  { value: 5, label: 'trifft zu' },
  { value: 6, label: 'trifft voll und ganz zu' },
]

// One starting point per shape of page the study uses; together they show
// every question type the engine has. The preview below the form renders
// whichever is chosen.
const PRESETS: { name: string; questions: Question[] }[] = [
  {
    name: 'Skalen',
    questions: [
      {
        id: 'auth1',
        type: 'likert',
        text: 'Ich empfand die Simulation als authentisch.',
        scale_min: 1,
        scale_max: 6,
        labels: { min: 'trifft überhaupt nicht zu', max: 'trifft voll und ganz zu' },
      },
      {
        id: 'td_effort',
        type: 'slider',
        text: 'Wie viel Anstrengung haben Sie investiert?',
        min: 0,
        max: 9,
        labels: { min: 'sehr, sehr wenig', max: 'sehr, sehr viel' },
      },
    ],
  },
  {
    name: 'Tabelle (wie MSK)',
    questions: ['a', 'b', 'c'].map((letter, i) => ({
      id: `msk_pre_8${letter}`,
      type: 'multiple_choice',
      text: ['Die Aufgabe allein lösen.', 'Die Lösung vorher lesen.', 'Notizen machen.'][i],
      options: SCALE_6,
      matrix: 'msk_pre_8',
    })),
  },
  {
    name: 'Java-Code',
    questions: [
      {
        id: 'debug_exe_1',
        type: 'line_numbers',
        text: 'In welcher Zeile steckt der Fehler?',
        min: 1,
        max: 7,
        code: [
          'public int max(int[] a) {',
          '    int m = 0;',
          '    for (int i = 0; i <= a.length; i++) {',
          '        if (a[i] > m) m = a[i];',
          '    }',
          '    return m;',
          '}',
        ],
      },
      { id: 'debug_exe_1_why', type: 'free_text', text: 'Was ist der Fehler?' },
    ],
  },
  {
    name: 'Auswahl & Freitext',
    questions: [
      {
        id: 'java_ex',
        type: 'multiple_choice',
        text: 'Haben Sie schon in Java programmiert?',
        options: [
          { value: 1, label: 'Ja' },
          { value: 0, label: 'Nein' },
        ],
      },
      {
        id: 'java_years',
        type: 'number',
        text: 'Seit wie vielen Jahren?',
        min: 0,
        max: 40,
        show_if: { question: 'java_ex', equals: 1 },
      },
      {
        id: 'teach_class',
        type: 'free_text',
        text: 'Welche Klassenstufen haben Sie unterrichtet? (optional)',
        required: false,
      },
    ],
  },
]

const asJson = (questions: Question[]) => JSON.stringify(questions, null, 2)

const EXAMPLE = asJson(PRESETS[2].questions)

/** The JSON field as questions, or what is wrong with it. */
function parseQuestions(json: string): { questions: Question[] } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'Ungültiges JSON.' }
  }
  if (!Array.isArray(parsed)) return { error: 'Die Fragen müssen ein JSON-Array sein.' }
  return { questions: parsed as Question[] }
}

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
  const [description, setDescription] = useState('')
  const [section, setSection] = useState('')
  const [order, setOrder] = useState('0')
  const [json, setJson] = useState(EXAMPLE)
  const [err, setErr] = useState('')

  const parsed = useMemo(() => parseQuestions(json), [json])

  const submit = () => {
    if ('error' in parsed) {
      setErr(parsed.error)
      return
    }
    const questions = parsed.questions
    if (!title.trim()) {
      setErr('Titel erforderlich.')
      return
    }
    setErr('')
    create.mutate(
      {
        placement,
        title: title.trim(),
        description: description.trim(),
        section: section.trim(),
        order_index: Number(order) || 0,
        questions: questions as unknown[],
      },
      {
        onSuccess: () => {
          setTitle('')
          setDescription('')
        },
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
          <label className="label" htmlFor="new-page-title">
            Titel
          </label>
          <input
            id="new-page-title"
            className="input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="form-row">
          <label className="label" htmlFor="new-page-description">
            Beschreibung (Einleitung über den Fragen)
          </label>
          <textarea
            id="new-page-description"
            className="textarea"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
          <p className="muted small">
            Absätze durch eine Leerzeile trennen; Zeilen, die mit „- “ beginnen, werden eine
            Aufzählung; Java-Code zwischen eine Zeile <code>```</code> und eine weitere{' '}
            <code>```</code> setzen.
          </p>
        </div>
        <div className="form-row">
          <label className="label">Abschnitt</label>
          <input
            className="input"
            value={section}
            placeholder="z. B. Demographics, CK-Pretest, MSK"
            onChange={(e) => setSection(e.target.value)}
          />
          <p className="muted small">
            Das Instrument, zu dem die Seite gehört. Die Bearbeitungszeit wird in der Statistik je
            Abschnitt aufsummiert; ohne Angabe zählt die Seite für sich.
          </p>
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
          <label className="label" htmlFor="new-page-questions">
            Fragen (JSON-Array)
          </label>
          <p className="muted small">
            Vorlagen zum Anpassen:{' '}
            {PRESETS.map((preset) => (
              <button
                key={preset.name}
                type="button"
                className="btn btn-secondary btn-sm"
                style={{ marginRight: 6 }}
                onClick={() => {
                  setJson(asJson(preset.questions))
                  setErr('')
                }}
              >
                {preset.name}
              </button>
            ))}
          </p>
          <textarea
            id="new-page-questions"
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
          <p className="muted small">
            Java-Code zu einer Frage kommt unter <code>"code"</code>, ein Eintrag pro Zeile:{' '}
            <code>{'"code": ["int i = 0;", "while (i <= n) {", "  i++;", "}"]'}</code>. Er erscheint
            als Codefenster mit Zeilennummern über dem Antwortfeld – für „In welcher Zeile steckt
            der Fehler?“ ist die Frage dann vom Typ <code>line_numbers</code>: Für denselben Fehler
            lassen sich beliebig viele Zeilen hinzufügen. Die Begründung bleibt ein gemeinsames
            Freitextfeld. <code>min</code> und <code>max</code> begrenzen die Zeilennummern, nicht
            die Anzahl der Angaben, und beziehen sich auf die angezeigten Zeilennummern.
            Code-Ausschnitte auf derselben Seite werden fortlaufend nummeriert. Ausgeblendete Fragen
            behalten ihre Zeilennummern reserviert. Mit <code>code_start_line</code> kann ein
            Ausschnitt ausdrücklich an einer anderen Zeilennummer beginnen.
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

      <div className="card">
        <h2>Vorschau</h2>
        <p className="muted small">
          So sieht die Seite für Teilnehmer aus – gerendert von derselben Engine, mit dem Text und
          den Fragen von oben. Der Weiter-Button tut hier nichts.
        </p>
        {'error' in parsed ? (
          <p className="error-text">{parsed.error}</p>
        ) : (
          <div className="preview" aria-label="Vorschau">
            <QuestionnaireRenderer
              key={`${title}\u0000${description}\u0000${json}`}
              title={title.trim() || 'Titel der Seite'}
              instruction={description}
              questions={parsed.questions}
              onSubmit={() => undefined}
            />
          </div>
        )}
      </div>

      <table className="table">
        <thead>
          <tr>
            <th>ID</th>
            <th>Platzierung</th>
            <th>Titel</th>
            <th>Abschnitt</th>
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
              <td>
                <SectionCell studyId={studyId} id={q.id} value={q.section} />
              </td>
              <td>
                <ExistingCodeQuestions studyId={studyId} questionnaire={q} />
              </td>
              <td>
                <button type="button" className="btn btn-ghost btn-sm" onClick={() => remove(q.id)}>
                  Löschen
                </button>
              </td>
            </tr>
          ))}
          {qs.data?.length === 0 && (
            <tr>
              <td colSpan={6} className="muted">
                Noch keine Fragebögen.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  )
}

function ExistingCodeQuestions({
  studyId,
  questionnaire,
}: {
  studyId: number
  questionnaire: AdminQuestionnaire
}) {
  const update = useUpdateQuestionnaire(studyId)
  const candidates = questionnaire.questions.flatMap((raw, index) => {
    if (!raw || typeof raw !== 'object') return []
    const question = raw as Question
    const hasCode =
      (typeof question.code === 'string' || Array.isArray(question.code)) &&
      codeLines(question.code).length > 0
    return question.id && hasCode && ['number', 'line_numbers'].includes(question.type)
      ? [{ question, index }]
      : []
  })
  if (!candidates.length) return <>{questionnaire.questions.length}</>

  const convert = (index: number) =>
    update.mutate({
      id: questionnaire.id,
      questions: questionnaire.questions.map((question, i) =>
        i === index ? { ...(question as Question), type: 'line_numbers' } : question,
      ),
    })

  return (
    <details>
      <summary>{questionnaire.questions.length} Fragen · Codefragen</summary>
      <p className="muted small">
        Bestehende Codefragen werden einzeln umgestellt. Gespeicherte Antworten und die gemeinsame
        Begründung bleiben erhalten. Bitte zwischen zwei Durchläufen ändern.
      </p>
      <ul className="prose-list">
        {candidates.map(({ question, index }) => (
          <li key={`${question.id}-${index}`}>
            <p>
              <strong>{question.id}</strong> · {question.text}
            </p>
            {question.type === 'number' ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                aria-label={`Mehrere Zeilennummern erlauben: ${question.id}`}
                disabled={update.isPending}
                onClick={() => convert(index)}
              >
                Mehrere Zeilennummern erlauben
              </button>
            ) : (
              <span className="muted small">Mehrere Zeilennummern erlaubt.</span>
            )}
          </li>
        ))}
      </ul>
      {update.isError && (
        <p className="error-text" role="alert">
          Die Codefrage konnte nicht umgestellt werden.
        </p>
      )}
      {update.isSuccess && (
        <p className="muted small" role="status">
          Codefrage gespeichert.
        </p>
      )}
    </details>
  )
}

/** The section, edited in place: saved when the field is left or Enter is
 *  pressed, and only if it changed. */
function SectionCell({ studyId, id, value }: { studyId: number; id: number; value: string }) {
  const update = useUpdateQuestionnaire(studyId)
  const [draft, setDraft] = useState(value)

  const save = () => {
    const next = draft.trim()
    if (next === value) return
    update.mutate({ id, section: next })
  }

  return (
    <>
      <input
        className="input"
        aria-label={`Abschnitt von Fragebogen ${id}`}
        value={draft}
        placeholder="—"
        onChange={(e) => setDraft(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
        }}
        disabled={update.isPending}
      />
      {update.isError && <div className="error-text small">Nicht gespeichert.</div>}
    </>
  )
}
