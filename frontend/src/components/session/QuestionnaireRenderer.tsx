import { useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { useTranslation } from 'react-i18next'

import { useElapsedSeconds } from '../../hooks/useElapsedSeconds'
import { studyCodeLineCount } from '../../lib/code'
import CodeBlock from '../CodeBlock'
import StudyText from '../StudyText'
import {
  groupQuestions,
  lineEntryLimit,
  missingRequired,
  numberCodeQuestions,
  normaliseOption,
  validLineNumbers,
  validRanking,
  visibleQuestionIds,
  type Answers,
  type Question,
  type QuestionBlock,
  type QuestionOption,
} from '../../lib/questionnaire'
import './QuestionnaireRenderer.css'

interface Props {
  title: string
  description?: string
  /** The battery's own instruction, under a heading the screen supplies. */
  instruction?: string
  questions: Question[]
  submitting?: boolean
  disabled?: boolean
  /** What the page opens with: the stored answers, when the run was stepped back onto it. */
  initialAnswers?: Answers
  onAnswersChange?: (answers: Answers) => void
  onSubmit: (answers: Answers, timeSpentSeconds: number) => void
}

export default function QuestionnaireRenderer({
  title,
  description,
  instruction,
  questions,
  submitting,
  disabled,
  initialAnswers,
  onAnswersChange,
  onSubmit,
}: Props) {
  const { t } = useTranslation()
  const [answers, setAnswers] = useState<Answers>(initialAnswers ?? {})
  const elapsed = useElapsedSeconds()
  const missing = useMemo(() => missingRequired(questions, answers), [questions, answers])
  const instructionStart = 1 + studyCodeLineCount(description ?? '')
  const questionsStart = instructionStart + studyCodeLineCount(instruction ?? '')

  return (
    <div className="panel panel--form">
      <header className="qhead">
        <h2 data-aoi="page_title">{title}</h2>
        {description ? (
          <div data-aoi="page_description">
            <StudyText text={description} className="muted" />
          </div>
        ) : null}
        {instruction ? (
          <div data-aoi="instructions">
            <StudyText text={instruction} className="lead" startLine={instructionStart} />
          </div>
        ) : null}
      </header>

      <fieldset className="questionnaire-controls" disabled={disabled || submitting}>
        <QuestionnaireFields
          questions={questions}
          answers={answers}
          onChange={(next) => {
            setAnswers(next)
            onAnswersChange?.(next)
          }}
          startLine={questionsStart}
        />
      </fieldset>

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
          data-aoi="continue"
          disabled={missing.length > 0 || submitting || disabled}
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
  startLine = 1,
}: {
  questions: Question[]
  answers: Answers
  onChange: (next: Answers) => void
  startLine?: number
}) {
  const visible = useMemo(() => visibleQuestionIds(questions, answers), [questions, answers])
  const numbered = useMemo(() => numberCodeQuestions(questions, startLine), [questions, startLine])
  const blocks = useMemo(
    () => groupQuestions(numbered.filter((q) => visible.has(q.id))),
    [numbered, visible],
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
      <ol className="matrix__legend" data-aoi={`matrix.${block.key}.legend`}>
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
              <tr key={q.id} data-aoi={`question.${q.id}`}>
                <th
                  scope="row"
                  className="matrix__item"
                  data-aoi={`question.${q.id}.prompt`}
                  data-aoi-priority="2"
                  data-aoi-row-prompt=""
                >
                  {q.text}
                  {q.required !== false ? <span className="req"> *</span> : null}
                </th>
                {block.options.map((option, i) => (
                  <td
                    key={String(option.value)}
                    data-aoi={`question.${q.id}.answer`}
                    data-aoi-priority="1"
                    data-aoi-clip="after-row-prompt"
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
    <fieldset
      className={`qfield${question.type === 'debugging' ? ' qfield--debugging' : ''}`}
      data-aoi={`question.${question.id}`}
    >
      <legend
        className="qfield__text"
        data-aoi={`question.${question.id}.prompt`}
        data-aoi-priority="1"
      >
        {question.text}
        {required ? <span className="req"> *</span> : null}
      </legend>
      <div className="qfield__body">
        {question.code_blocks?.length ? (
          <div
            className="question-code-files"
            data-aoi={`question.${question.id}.code`}
            data-aoi-priority="1"
          >
            {question.code_blocks.map((block, index) => (
              <figure className="question-code-file" key={index}>
                {block.filename ? <figcaption>{block.filename}</figcaption> : null}
                <CodeBlock code={block.code} startLine={block.start_line} preserveBlankLines />
              </figure>
            ))}
          </div>
        ) : question.code ? (
          <div data-aoi={`question.${question.id}.code`} data-aoi-priority="1">
            <CodeBlock code={question.code} startLine={question.code_start_line} />
          </div>
        ) : null}
        <div data-aoi={`question.${question.id}.answer`} data-aoi-priority="1">
          <Control question={question} value={value} onChange={onChange} />
        </div>
      </div>
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
    case 'multi_select':
      return <MultiSelect question={question} value={value} onChange={onChange} />
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
    case 'line_numbers':
      return <LineNumbers question={question} value={value} onChange={onChange} />
    case 'debugging':
      return <Debugging question={question} value={value} onChange={onChange} />
    case 'ranking':
      return <Ranking question={question} value={value} onChange={onChange} />
    default:
      // The question JSON is written by hand in the admin, so a typo in `type`
      // lands here. Saying so beats a heading with nothing under it and a
      // submit button that can never enable.
      return <UnsupportedQuestion type={question.type} />
  }
}

function MultiSelect({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (next: unknown) => void
}) {
  const { t } = useTranslation()
  const hintId = useId()
  const selected: unknown[] = Array.isArray(value) ? value : []
  return (
    <div className="choice">
      <p className="muted small" id={hintId}>
        {t('questionnaire.multi_select_hint')}
      </p>
      {(question.options ?? []).map(normaliseOption).map((option) => (
        <label key={`${typeof option.value}:${option.value}`} className="choice__option">
          <input
            type="checkbox"
            name={question.id}
            aria-describedby={hintId}
            checked={selected.includes(option.value)}
            onChange={(event) =>
              onChange(
                event.target.checked
                  ? [...selected, option.value]
                  : selected.filter((item) => item !== option.value),
              )
            }
          />
          <span>{option.label}</span>
        </label>
      ))}
    </div>
  )
}

function LineNumbers({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (next: unknown) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const root = useRef<HTMLDivElement>(null)
  const focusNext = useRef<number | null>(null)
  const nextId = useRef(0)
  const [rows, setRows] = useState(() => {
    const initial = Array.isArray(value) ? (value.length ? value : [undefined]) : [value]
    return initial.map((line) => ({ id: nextId.current++, value: (line ?? undefined) as unknown }))
  })
  const min = Math.max(1, question.min ?? 1)
  const maxEntries = lineEntryLimit(question)
  const omitted = value == null || (Array.isArray(value) && value.length === 0)
  const invalid = !omitted && !validLineNumbers(question, value)
  const errorId = `${id}-error`

  useLayoutEffect(() => {
    const index = focusNext.current
    if (index === null) return
    root.current?.querySelectorAll('input')[index]?.focus()
    focusNext.current = null
  }, [rows])

  const update = (next: typeof rows) => {
    setRows(next)
    const values = next.map((row) => row.value)
    onChange(values.every((line) => line === undefined) && next.length === 1 ? [] : values)
  }

  return (
    <div className="line-numbers" ref={root}>
      {rows.map((row, index) => (
        <div className="line-numbers__row" key={row.id}>
          <div className="line-numbers__field">
            <label htmlFor={`${id}-${row.id}`}>
              {t('questionnaire.line_number', { index: index + 1 })}
            </label>
            <input
              id={`${id}-${row.id}`}
              className="input"
              type="number"
              min={min}
              max={question.max}
              step={1}
              value={row.value === undefined || row.value === null ? '' : String(row.value)}
              aria-label={`${question.text}: ${t('questionnaire.line_number', { index: index + 1 })}`}
              aria-invalid={invalid || undefined}
              aria-describedby={invalid ? errorId : undefined}
              onChange={(e) =>
                update(
                  rows.map((current) =>
                    current.id === row.id
                      ? {
                          ...current,
                          value: e.target.value === '' ? undefined : Number(e.target.value),
                        }
                      : current,
                  ),
                )
              }
            />
          </div>
          {rows.length > 1 && (
            <button
              type="button"
              className="btn btn-ghost"
              aria-label={t('questionnaire.remove_line', { index: index + 1 })}
              onClick={() => {
                focusNext.current = Math.min(index, rows.length - 2)
                update(rows.filter((current) => current.id !== row.id))
              }}
            >
              {t('questionnaire.remove_line', { index: index + 1 })}
            </button>
          )}
          {index === rows.length - 1 && (
            <button
              type="button"
              className="btn btn-secondary line-numbers__add"
              disabled={maxEntries !== undefined && rows.length >= maxEntries}
              onClick={() => {
                if (maxEntries !== undefined && rows.length >= maxEntries) return
                focusNext.current = rows.length
                update([...rows, { id: nextId.current++, value: undefined }])
              }}
            >
              {t('questionnaire.add_line')}
            </button>
          )}
        </div>
      ))}
      {maxEntries !== undefined ? (
        <p className="muted small">
          {t('questionnaire.line_entries_limit', { count: maxEntries })}
        </p>
      ) : null}
      {invalid && (
        <p className="error-text" id={errorId}>
          {t(
            maxEntries !== undefined && rows.length > maxEntries
              ? 'questionnaire.line_entries_limit'
              : question.max === undefined
                ? 'questionnaire.line_numbers_invalid'
                : 'questionnaire.line_numbers_range',
            { min, max: question.max, count: maxEntries },
          )}
        </p>
      )}
    </div>
  )
}

function Debugging({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (next: unknown) => void
}) {
  const { t } = useTranslation()
  const explanationId = useId()
  const answer =
    value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  return (
    <div className="debugging-answer">
      <LineNumbers
        question={question}
        value={answer.lines}
        onChange={(lines) => onChange({ ...answer, lines })}
      />
      <label htmlFor={explanationId}>{t('questionnaire.debugging_explanation')}</label>
      <textarea
        id={explanationId}
        className="textarea"
        value={typeof answer.explanation === 'string' ? answer.explanation : ''}
        onChange={(event) => onChange({ ...answer, explanation: event.target.value })}
      />
    </div>
  )
}

function Ranking({
  question,
  value,
  onChange,
}: {
  question: Question
  value: unknown
  onChange: (next: unknown) => void
}) {
  const { t } = useTranslation()
  const options = (question.options ?? []).map(normaliseOption)
  const answered = validRanking(question, value)
  const order = answered ? value : options.map((option) => option.value)
  const move = (index: number, direction: number) => {
    const next = [...order]
    const target = index + direction
    if (target < 0 || target >= next.length) return
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <div className="ranking">
      <p className="muted small">{t('questionnaire.ranking_instruction')}</p>
      <ol className="ranking__list">
        {order.map((optionValue, index) => {
          const option = options.find((candidate) => candidate.value === optionValue)!
          return (
            <li key={`${typeof optionValue}:${optionValue}`} className="ranking__item">
              <span className="ranking__position" aria-hidden="true">
                {index + 1}
              </span>
              <span className="ranking__label">{option.label}</span>
              <div className="ranking__actions">
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={`${option.label}: ${t('questionnaire.ranking_up')}`}
                  disabled={index === 0}
                  onClick={() => move(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="btn btn-secondary"
                  aria-label={`${option.label}: ${t('questionnaire.ranking_down')}`}
                  disabled={index === order.length - 1}
                  onClick={() => move(index, 1)}
                >
                  ↓
                </button>
              </div>
            </li>
          )
        })}
      </ol>
      {!answered ? (
        <button type="button" className="btn btn-secondary" onClick={() => onChange(order)}>
          {t('questionnaire.ranking_confirm')}
        </button>
      ) : null}
      <p className="muted small" role="status">
        {t(answered ? 'questionnaire.ranking_saved' : 'questionnaire.unanswered')}
      </p>
    </div>
  )
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
