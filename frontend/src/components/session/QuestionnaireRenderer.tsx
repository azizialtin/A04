import { useMemo, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { useElapsedSeconds } from '../../hooks/useElapsedSeconds'
import {
  groupQuestions,
  missingRequired,
  normaliseOption,
  visibleQuestionIds,
  type Answers,
  type Question,
  type QuestionBlock,
  type QuestionOption,
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
    <div className="panel panel--form">
      <header className="qhead">
        <h2>{title}</h2>
        {description ? <p className="muted">{description}</p> : null}
        {instruction ? <p className="lead">{instruction}</p> : null}
      </header>

      <QuestionnaireFields questions={questions} answers={answers} onChange={setAnswers} />

      {/* How many are left, not only that something is: a table of seven rows
          gives no clue why the button will not light up. */}
      {missing.length > 0 && questions.length > 1 ? (
        <p className="muted small">
          {t('questionnaire.still_open', { count: missing.length, total: questions.length })}
        </p>
      ) : null}

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
  const blocks = useMemo(
    () => groupQuestions(questions.filter((q) => visible.has(q.id))),
    [questions, visible],
  )
  const setAnswer = (id: string, value: unknown) => onChange({ ...answers, [id]: value })

  return (
    <div className="qlist">
      {blocks.map((block) =>
        block.kind === 'matrix' ? (
          <Matrix
            key={`${block.key}:${block.questions[0].id}`}
            block={block}
            answers={answers}
            onAnswer={setAnswer}
          />
        ) : (
          <Field
            key={block.question.id}
            question={block.question}
            value={answers[block.question.id]}
            onChange={(v) => setAnswer(block.question.id, v)}
          />
        ),
      )}
    </div>
  )
}

/**
 * Several questions that share one set of statements, as a table: the
 * statements once, numbered, above it; a row per question with a radio under
 * each number. The variable names and the stored values are the rows' own —
 * this is presentation only.
 */
function Matrix({
  block,
  answers,
  onAnswer,
}: {
  block: Extract<QuestionBlock, { kind: 'matrix' }>
  answers: Answers
  onAnswer: (id: string, value: unknown) => void
}) {
  const { t } = useTranslation()
  const numbered = (option: QuestionOption, i: number) => `${i + 1} – ${option.label}`
  return (
    <div className="matrix">
      <p className="matrix__legend-title">{t('questionnaire.legend')}</p>
      <ol className="matrix__legend">
        {block.options.map((option, i) => (
          <li key={String(option.value)}>
            <span className="matrix__num" aria-hidden="true">
              {i + 1}
            </span>
            <span>{option.label}</span>
          </li>
        ))}
      </ol>
      <div className="matrix__scroll">
        <table className="matrix__table">
          <thead>
            <tr>
              <th scope="col" className="matrix__item" />
              {block.options.map((option, i) => (
                <th key={String(option.value)} scope="col" title={option.label}>
                  <span className="matrix__num">{i + 1}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.questions.map((q) => (
              <tr key={q.id}>
                <th scope="row" className="matrix__item">
                  {q.text}
                  {q.required !== false ? <span className="req"> *</span> : null}
                </th>
                {block.options.map((option, i) => (
                  <td
                    key={String(option.value)}
                    className={answers[q.id] === option.value ? 'is-chosen' : undefined}
                  >
                    <label className="matrix__cell" title={option.label}>
                      <input
                        type="radio"
                        name={q.id}
                        required={q.required !== false}
                        checked={answers[q.id] === option.value}
                        onChange={() => onAnswer(q.id, option.value)}
                        // The row and the statement, since the cell shows only a number.
                        aria-label={`${q.text}: ${numbered(option, i)}`}
                      />
                    </label>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
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
          <Anchors labels={question.labels} />
          {/* One column per point, so the anchors above line up with the ends
              of the scale and every option is the same size to hit. */}
          <div className="likert__scale" style={{ '--points': points.length } as CSSProperties}>
            {points.map((p) => (
              <label
                key={p}
                className={value === p ? 'likert__option is-chosen' : 'likert__option'}
              >
                <input
                  type="radio"
                  name={question.id}
                  checked={value === p}
                  onChange={() => onChange(p)}
                />
                <span>{p}</span>
              </label>
            ))}
          </div>
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
      // The question JSON is written by hand in the admin, so a typo in `type`
      // lands here. Saying so beats a heading with nothing under it and a
      // submit button that can never enable.
      return <UnsupportedQuestion type={question.type} />
  }
}

function UnsupportedQuestion({ type }: { type: string }) {
  const { t } = useTranslation()
  return <p className="error-text">{t('questionnaire.unsupported', { type })}</p>
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
      <Anchors labels={question.labels} />
      <div className="scale__row">
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
        <output className={answered ? 'scale__value' : 'scale__value is-unset'}>
          {answered ? value : '—'}
        </output>
      </div>
      <div className="scale__ticks" aria-hidden="true">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  )
}

/** The two ends of a scale, above it and pushed to its edges. */
function Anchors({ labels }: { labels?: { min?: string; max?: string } }) {
  if (!labels?.min && !labels?.max) return null
  return (
    <div className="anchors">
      <span>{labels.min ?? ''}</span>
      <span>{labels.max ?? ''}</span>
    </div>
  )
}
