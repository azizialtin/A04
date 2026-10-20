import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { NoteSnapshot } from '../../api/participant'
import { useElapsedSeconds } from '../../hooks/useElapsedSeconds'
import { useLocalDraft } from '../../hooks/useLocalDraft'
import { studyCodeLineCount } from '../../lib/code'
import { missingRequired, type Answers, type Question } from '../../lib/questionnaire'
import StudyText from '../StudyText'
import { QuestionnaireFields } from './QuestionnaireRenderer'

interface Props {
  taskDescription: string
  notes: NoteSnapshot[]
  draftKey: string
  /** Rating questions shown under the write-up and submitted with it. */
  questions?: Question[]
  submitting?: boolean
  /** The stored diagnosis, when the run was stepped back onto this screen. */
  initialText?: string
  initialAnswers?: Answers
  onSubmit: (text: string, timeSpentSeconds: number, answers: Answers) => void
}

export default function DiagnosisView({
  taskDescription,
  notes,
  draftKey,
  questions = [],
  submitting,
  initialText,
  initialAnswers,
  onSubmit,
}: Props) {
  const { t } = useTranslation()
  // Held locally as it is typed: nothing reaches the server until submit, so a
  // reload here would otherwise lose the whole answer.
  const [text, setText] = useLocalDraft(draftKey)
  const [answers, setAnswers] = useState<Answers>(initialAnswers ?? {})
  // A stored diagnosis seeds an empty draft once; a draft in progress wins.
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current) return
    seeded.current = true
    if (!text && initialText) setText(initialText)
  }, [text, initialText, setText])
  const elapsed = useElapsedSeconds()

  // The last snapshot is the fullest version of what they wrote.
  const notesText = notes.length ? notes[notes.length - 1].text : ''
  const incomplete = !text.trim() || missingRequired(questions, answers).length > 0

  return (
    <div className="panel panel--form">
      <h2 data-aoi="page_title">{t('diagnosis.title')}</h2>
      {taskDescription ? (
        <div data-aoi="task">
          <StudyText text={taskDescription} className="muted" />
        </div>
      ) : null}

      <label className="label" htmlFor="diagnosis-text" data-aoi="diagnosis_prompt">
        {t('diagnosis.prompt')}
      </label>
      <textarea
        id="diagnosis-text"
        data-aoi="diagnosis_answer"
        className="textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('diagnosis.placeholder')}
        style={{ minHeight: 160 }}
      />

      <QuestionnaireFields
        questions={questions}
        answers={answers}
        onChange={setAnswers}
        startLine={1 + studyCodeLineCount(taskDescription)}
      />

      <div className="notes-recap" data-aoi="notes">
        <span className="label">{t('diagnosis.your_notes')}</span>
        {notesText ? (
          <p className="notes-recap__text">{notesText}</p>
        ) : (
          <p className="muted">{t('diagnosis.no_notes')}</p>
        )}
      </div>

      <div className="panel__actions">
        <button
          type="button"
          className="btn btn-primary"
          data-aoi="continue"
          disabled={incomplete || submitting}
          onClick={() => onSubmit(text, elapsed(), answers)}
        >
          {submitting ? t('common.loading') : t('diagnosis.submit')}
        </button>
      </div>
    </div>
  )
}
