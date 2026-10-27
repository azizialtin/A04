import { useMemo, useRef, useState } from 'react'

import type { AxiosError } from 'axios'

import type { AdminQuestionnaire } from '../../api/admin'
import {
  useCreateQuestionnaire,
  useDeleteQuestionnaire,
  useQuestionnaires,
  useSeedQuestionnaires,
  useUpdateQuestionnaire,
} from '../../hooks/admin'
import { definitionErrors, type Question } from '../../lib/questionnaire'
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
    name: 'Mehrfachauswahl',
    questions: [
      {
        id: 'pck_select_example',
        type: 'multi_select',
        text: 'Welche Unterstützungsmaßnahmen würden Sie auswählen?',
        options: [
          { value: 'trace', label: 'Die Variablenwerte gemeinsam nachvollziehen.' },
          { value: 'compare', label: 'Das erwartete und beobachtete Ergebnis vergleichen.' },
          { value: 'explain', label: 'Die Schülerin ihren Lösungsweg erklären lassen.' },
        ],
      },
    ],
  },
  {
    name: 'CK-Debugging (max. 5 Zeilen)',
    questions: [
      {
        id: 'ck_task_example',
        type: 'debugging',
        text: 'In welcher Zeile befindet sich der Fehler? Was ist der Fehler?',
        min: 1,
        max: 3,
        max_entries: 5,
        code_blocks: [
          {
            filename: 'Beispiel.java',
            code: ['int x = 1;', 'x = x + 1', 'System.out.println(x);'],
          },
        ],
      },
    ],
  },
  {
    name: 'Reihenfolge (PCK)',
    questions: [
      {
        id: 'pck_order_example',
        type: 'ranking',
        text: 'Ordnen Sie die Schritte von zuerst bis zuletzt.',
        options: [
          { value: 'observe', label: 'Beobachtetes und erwartetes Ergebnis vergleichen.' },
          { value: 'trace', label: 'Variablenwerte nachvollziehen.' },
          { value: 'check', label: 'Schleife überprüfen.' },
          { value: 'test', label: 'Korrigiertes Programm ausführen.' },
        ],
      },
    ],
  },
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

const EXAMPLE = asJson(PRESETS.find((preset) => preset.name === 'Java-Code')!.questions)

/** The JSON field as questions, or what is wrong with it. */
function parseQuestions(json: string): { questions: Question[] } | { error: string } {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch {
    return { error: 'Ungültiges JSON.' }
  }
  if (!Array.isArray(parsed)) return { error: 'Die Fragen müssen ein JSON-Array sein.' }
  const errors = definitionErrors(parsed)
  if (errors.length) return { error: 'Fragen prüfen: ' + errors.join(' ') }
  return { questions: parsed as Question[] }
}

// Only a 409 means "that placement is taken"; an expired session or a dropped
// connection must not send the researcher off deleting a battery.
const isConflict = (error: unknown) => (error as AxiosError)?.response?.status === 409

export default function QuestionnairesSection({ studyId }: { studyId: number }) {
  const qs = useQuestionnaires(studyId)
  const create = useCreateQuestionnaire(studyId)
  const update = useUpdateQuestionnaire(studyId)
  const seed = useSeedQuestionnaires(studyId)
  const del = useDeleteQuestionnaire(studyId)

  const [placement, setPlacement] = useState('pre_test')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [section, setSection] = useState('')
  const [sectionKey, setSectionKey] = useState('')
  const [introTitle, setIntroTitle] = useState('')
  const [introBody, setIntroBody] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const titleInput = useRef<HTMLInputElement>(null)
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
    const body = {
      placement,
      title: title.trim(),
      description: description.trim(),
      section: section.trim(),
      section_key: placement === 'pre_test' ? sectionKey.trim() : '',
      intro_title: placement === 'pre_test' ? introTitle.trim() : '',
      intro_body: placement === 'pre_test' ? introBody.trim() : '',
      order_index: Number(order) || 0,
      questions: questions as unknown[],
    }
    const callbacks = {
      onSuccess: () => {
        setTitle('')
        setDescription('')
        setEditingId(null)
        setErr('')
      },
      onError: (error: unknown) =>
        setErr(
          isConflict(error)
            ? 'Diese Änderung ist nicht möglich: Die Studie hat bereits gestartete Durchläufe, oder die Platzierung ist belegt.'
            : 'Der Fragebogen konnte nicht gespeichert werden. Bitte prüfen Sie die Angaben.',
        ),
    }
    if (editingId !== null) update.mutate({ id: editingId, ...body }, callbacks)
    else create.mutate(body, callbacks)
  }

  const edit = (q: AdminQuestionnaire) => {
    setEditingId(q.id)
    setPlacement(q.placement)
    setTitle(q.title)
    setDescription(q.description)
    setSection(q.section)
    setSectionKey(q.section_key ?? '')
    setIntroTitle(q.intro_title ?? '')
    setIntroBody(q.intro_body ?? '')
    setOrder(String(q.order_index))
    setJson(JSON.stringify(q.questions, null, 2))
    setErr('')
    titleInput.current?.focus()
    titleInput.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  }

  const remove = (id: number) => {
    if (!window.confirm('Fragebogen endgültig löschen?')) return
    del.mutate(
      { id },
      {
        onError: () =>
          setErr(
            'Löschen nicht möglich. Gestartete Durchläufe und gespeicherte Antworten bleiben erhalten.',
          ),
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
        <h2>
          {editingId === null ? 'Fragebogen anlegen' : 'Fragebogen bearbeiten · ' + editingId}
        </h2>
        {editingId !== null && (
          <p className="muted small">
            Inhalt und Reihenfolge können vor dem ersten Durchlauf geändert werden.
          </p>
        )}
        <div className="form-row">
          <label className="label" htmlFor="page-placement">
            Platzierung
          </label>
          <select
            id="page-placement"
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
            ref={titleInput}
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
          <label className="label" htmlFor="page-section">
            Abschnitt
          </label>
          <input
            id="page-section"
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
          <label className="label" htmlFor="page-order">
            Reihenfolge
          </label>
          <input
            id="page-order"
            className="input"
            type="number"
            value={order}
            onChange={(e) => setOrder(e.target.value)}
          />
        </div>
        {placement === 'pre_test' && (
          <fieldset className="form">
            <legend>Abschnitt und Einleitungsseite</legend>
            <label className="label" htmlFor="page-section-key">
              Abschnittsfunktion
            </label>
            <select
              id="page-section-key"
              className="input"
              value={sectionKey}
              onChange={(event) => setSectionKey(event.target.value)}
            >
              <option value="">Ohne Abschnittssteuerung</option>
              <option value="ck_tasks">
                CK-Aufgaben · 7 Minuten, Abschluss durch Studienleitung
              </option>
              <option value="pck">PCK · Ziel nach den CK-Aufgaben</option>
              <option value="ck_self">CK-Selbsteinschätzung</option>
              <option value="msk">MSK</option>
              <option value="demographics">Demographie</option>
              {sectionKey &&
                !['ck_tasks', 'pck', 'ck_self', 'msk', 'demographics'].includes(sectionKey) && (
                  <option value={sectionKey}>{sectionKey}</option>
                )}
            </select>
            <p className="muted small">
              Alle Seiten eines Abschnitts stehen direkt hintereinander. Die Einleitung wird einmal
              vor der ersten Seite angezeigt; ihre Lesezeit zählt nicht zu den sieben Minuten.
              Einleitungstext nur auf der ersten ausgefüllten Seite eines Abschnitts eintragen.
            </p>
            <label className="label" htmlFor="page-intro-title">
              Überschrift der Abschnittseinleitung
            </label>
            <input
              id="page-intro-title"
              className="input"
              value={introTitle}
              onChange={(event) => setIntroTitle(event.target.value)}
            />
            <label className="label" htmlFor="page-intro-body">
              Text der Abschnittseinleitung
            </label>
            <textarea
              id="page-intro-body"
              className="textarea"
              value={introBody}
              onChange={(event) => setIntroBody(event.target.value)}
            />
          </fieldset>
        )}
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
            lassen sich mehrere Zeilen hinzufügen. <code>max_entries: 5</code> begrenzt die Anzahl.
            Der Typ <code>debugging</code> speichert Zeilen und Begründung gemeinsam und erlaubt
            standardmäßig höchstens fünf Angaben. <code>min</code> und <code>max</code> begrenzen
            die Zeilennummern, nicht die Anzahl der Angaben, und beziehen sich auf die angezeigten
            Zeilennummern. Code-Ausschnitte auf derselben Seite werden fortlaufend nummeriert.
            Ausgeblendete Fragen behalten ihre Zeilennummern reserviert. Mit{' '}
            <code>code_start_line</code> kann ein Ausschnitt ausdrücklich an einer anderen
            Zeilennummer beginnen.
          </p>
        </div>
        {err && <p className="error-text">{err}</p>}
        <button
          type="button"
          className="btn btn-primary"
          onClick={submit}
          disabled={create.isPending || update.isPending}
        >
          {editingId === null ? 'Anlegen' : 'Änderungen speichern'}
        </button>
        {editingId !== null && (
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setEditingId(null)
              setTitle('')
              setDescription('')
              setSection('')
              setSectionKey('')
              setIntroTitle('')
              setIntroBody('')
              setJson(EXAMPLE)
              setErr('')
            }}
          >
            Bearbeitung abbrechen
          </button>
        )}
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
                <SectionCell key={q.section} studyId={studyId} id={q.id} value={q.section} />
              </td>
              <td>
                <ExistingCodeQuestions studyId={studyId} questionnaire={q} />
              </td>
              <td>
                <button type="button" className="btn btn-secondary btn-sm" onClick={() => edit(q)}>
                  Bearbeiten
                </button>
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
