import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'

import { useElapsedSeconds } from '../../hooks/useElapsedSeconds'
import {
  missingRequired,
  normaliseOption,
  visibleQuestionIds,
  type Answers,
  type Question,
} from '../../lib/questionnaire'

interface Props {
  title: string
  description?: string
  /** The battery's own instruction, under a heading the screen supplies. */
  instruction?: string
  questions: Question[]
  submitting?: boolean
  onSubmit: (answers: Answers, timeSpentSeconds: number) => void
}

export default function QuestionnaireRenderer({
  title,
  description,
  instruction,
  questions,
  submitting,
  onSubmit,
}: Props) {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState<Answers>({})
  const elapsed = useElapsedSeconds()
  const missing = useMemo(() => missingRequired(questions, answers), [questions, answers])

  return (
    <div className="panel">
      <h2>{title}</h2>
      {description ? <p className="muted">{description}</p> : null}
      {instruction ? <p className="lead">{instruction}</p> : null}

      <QuestionnaireFields questions={questions} answers={answers} onChange={setAnswers} />

      <div className="panel__actions">
        <button
          type="button"
          className="btn btn-primary"
          disabled={missing.length > 0 || submitting}
          onClick={() => onSubmit(answers, elapsed())}
        >
          {submitting ? t('common.loading') : t('questionnaire.submit')}
        </button>
      </div>
    </div>
  )
}

/**
 * The fields on their own, for screens that own their submit button — the
 * written diagnosis, where the rating questions go under the text box and both
 * are sent together.
 */
export function QuestionnaireFields({
  questions,
  answers,
  onChange,
}: {
  questions: Question[]
  answers: Answers
  onChange: (next: Answers) => void
}) {
  const visible = useMemo(() => visibleQuestionIds(questions, answers), [questions, answers])
  const setAnswer = (id: string, value: unknown) => onChange({ ...answers, [id]: value })

  return (
    <div className="qlist">
      {questions
        .filter((q) => visible.has(q.id))
        .map((q) => (
          <Field key={q.id} question={q} value={answers[q.id]} onChange={(v) => setAnswer(q.id, v)} />
        ))}
    </div>
  )
}

function Field({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (v: unknown) => void
}) {
  const required = question.required !== false
  return (
    <fieldset className="qfield">
      <legend className="qfield__text">
        {question.text}
        {required ? <span className="req"> *</span> : null}
      </legend>
      <Control question={question} value={value} onChange={onChange} />
    </fieldset>
  )
}

function Control({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (v: unknown) => void
}) {
  switch (question.type) {
    case 'likert': {
      const min = question.scale_min ?? 1
      const max = question.scale_max ?? 5
      const points = Array.from({ length: max - min + 1 }, (_, i) => min + i)
      return (
        <div className="likert">
          {question.labels?.min ? <span className="likert__anchor">{question.labels.min}</span> : null}
          {points.map((p) => (
            <label key={p} className="likert__option">
              <input type="radio" name={question.id} checked={value === p} onChange={() => onChange(p)} />
              <span>{p}</span>
            </label>
          ))}
          {question.labels?.max ? <span className="likert__anchor">{question.labels.max}</span> : null}
        </div>
      )
    }
    case 'multiple_choice': {
      const options = (question.options ?? []).map(normaliseOption)
      return (
        <div className="choice">
          {options.map((opt) => (
            <label key={String(opt.value)} className="choice__option">
              <input
                type="radio"
                name={question.id}
                checked={value === opt.value}
                onChange={() => onChange(opt.value)}
              />
              <span>{opt.label}</span>
            </label>
          ))}
        </div>
      )
    }
    case 'free_text':
      return (
        <textarea
          className="textarea"
          value={(value as string) ?? ''}
          onChange={(e) => onChange(e.target.value)}
        />
      )
    case 'slider':
      return <Slider question={question} value={value} onChange={onChange} />
    case 'number':
      return (
        <input
          className="input"
          type="number"
          min={question.min}
          max={question.max}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      )
    default:
      return null
  }
}

/**
 * The VAS/rating slider. Until it is touched it has no answer — the handle rests
 * mid-scale and the readout is blank, so a participant who skipped the question
 * is not recorded as having chosen the lowest point.
 */
function Slider({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (v: unknown) => void
}) {
  const { t } = useTranslation()
  const min = question.min ?? 0
  const max = question.max ?? 9
  const answered = typeof value === 'number'
  // Also on pointer release: clicking the handle where it already rests fires no
  // change event, and that must still count as an answer. Deliberately not on
  // key release — the keyup of the Tab that moved focus here is delivered to
  // this input, and would record the resting handle as a chosen answer. Arrow
  // and Home/End keys move the handle and fire a change of their own.
  const commit = (el: HTMLInputElement) => onChange(Number(el.value))

  return (
    <div className="scale">
      {question.labels?.min ? <span className="scale__anchor">{question.labels.min}</span> : null}
      <input
        type="range"
        className={answered ? 'scale__range' : 'scale__range is-unset'}
        min={min}
        max={max}
        step={1}
        value={answered ? value : Math.round((min + max) / 2)}
        // Otherwise a screen reader announces the resting position as if it
        // were the participant's answer.
        aria-valuetext={answered ? undefined : t('questionnaire.unanswered')}
        onChange={(e) => commit(e.currentTarget)}
        onPointerUp={(e) => commit(e.currentTarget)}
      />
      {question.labels?.max ? <span className="scale__anchor">{question.labels.max}</span> : null}
      <output className="scale__value">{answered ? value : '—'}</output>
    </div>
  )
}
