// Frontend half of the questionnaire contract; mirrors the backend engine in
// app/services/questionnaires.py — keep the two in step.

import { codeLines } from './code'

export type QuestionType =
  | 'likert'
  | 'multiple_choice'
  | 'multi_select'
  | 'free_text'
  | 'slider'
  | 'number'
  | 'line_numbers'
  | 'debugging'
  | 'ranking'

export interface QuestionOption {
  value: string | number
  label: string
}

export interface QuestionCodeBlock {
  filename?: string
  code: string | string[]
  start_line?: number
}

export interface DebuggingAnswer {
  lines: number[]
  explanation: string
}

export interface Question {
  id: string
  type: QuestionType
  text: string
  required?: boolean
  show_if?: { question: string; equals: unknown }
  scale_min?: number
  scale_max?: number
  labels?: { min?: string; max?: string }
  options?: (string | QuestionOption)[]
  min?: number
  max?: number
  /** Number of reported locations, independently of the largest code line. */
  max_entries?: number
  /**
   * Consecutive single-choice questions with the same key and the same options
   * are shown as one table — a row each, the options listed once — rather
   * than the same list repeated under every question.
   */
  matrix?: string
  /**
   * Java shown above the answer field as a numbered code window — one entry
   * per line, or a string with newlines. For "which line is the bug in?", the
   * question can be `line_numbers` when one error refers to several lines.
   */
  code?: string | string[]
  /** Overrides the automatic continuation from earlier snippets on this page. */
  code_start_line?: number
  /** Authored files retain blank lines because their numbering is part of the task. */
  code_blocks?: QuestionCodeBlock[]
}

export type Answers = Record<string, unknown>

export function definitionErrors(questions: unknown): string[] {
  if (!Array.isArray(questions)) return ['Fragen müssen eine Liste sein.']
  const errors: string[] = []
  const ids = new Set<string>()
  const types = new Set([
    'likert',
    'multiple_choice',
    'multi_select',
    'free_text',
    'slider',
    'number',
    'line_numbers',
    'debugging',
    'ranking',
  ])
  const object = (value: unknown): value is Record<string, unknown> =>
    value !== null && typeof value === 'object' && !Array.isArray(value)
  const positiveInteger = (value: unknown) =>
    typeof value === 'number' && Number.isSafeInteger(value) && value > 0
  const validCode = (value: unknown) =>
    typeof value === 'string' ||
    (Array.isArray(value) && value.every((line) => typeof line === 'string'))
  const availableIds = new Set(
    questions
      .filter((question) => object(question) && typeof question.id === 'string')
      .map((question) => question.id),
  )

  questions.forEach((question, index) => {
    const prefix = `Frage ${index + 1}`
    if (!object(question)) {
      errors.push(`${prefix}: Ein Objekt wird erwartet.`)
      return
    }
    const id = question.id
    if (typeof id !== 'string' || !id.trim()) errors.push(`${prefix}: Eine ID fehlt.`)
    else if (ids.has(id)) errors.push(`${prefix}: Die ID ${id} ist doppelt vergeben.`)
    else ids.add(id)
    const kind = question.type
    if (typeof kind !== 'string' || !types.has(kind))
      errors.push(`${prefix}: Unbekannter Fragetyp.`)
    if (typeof question.text !== 'string') errors.push(`${prefix}: Fragetext fehlt.`)
    if ('required' in question && typeof question.required !== 'boolean') {
      errors.push(`${prefix}: required muss wahr oder falsch sein.`)
    }
    const condition = question.show_if
    if (
      condition != null &&
      (!object(condition) ||
        typeof condition.question !== 'string' ||
        !condition.question.trim() ||
        !availableIds.has(condition.question) ||
        !('equals' in condition))
    ) {
      errors.push(`${prefix}: Bedingung braucht eine Frage dieser Seite und einen Vergleichswert.`)
    }
    for (const field of ['max_entries', 'code_start_line']) {
      if (field in question && !positiveInteger(question[field])) {
        errors.push(`${prefix}: ${field} muss eine positive ganze Zahl sein.`)
      }
    }
    for (const field of ['min', 'max', 'scale_min', 'scale_max']) {
      if (!(field in question)) continue
      const value = question[field]
      if (
        typeof value !== 'number' ||
        !Number.isFinite(value) ||
        ((kind === 'line_numbers' || kind === 'debugging') && !positiveInteger(value))
      )
        errors.push(`${prefix}: ${field} ist ungültig.`)
    }
    if (
      typeof question.min === 'number' &&
      typeof question.max === 'number' &&
      question.min > question.max
    ) {
      errors.push(`${prefix}: min darf nicht größer als max sein.`)
    }
    if (kind === 'likert') {
      const lower = question.scale_min ?? 1
      const upper = question.scale_max ?? 5
      if (
        typeof lower !== 'number' ||
        typeof upper !== 'number' ||
        !Number.isInteger(lower) ||
        !Number.isInteger(upper) ||
        lower > upper
      ) {
        errors.push(`${prefix}: Likert-Grenzen müssen aufsteigende ganze Zahlen sein.`)
      }
    }
    if ('code' in question && !validCode(question.code)) {
      errors.push(`${prefix}: Code muss Text oder eine Liste von Textzeilen sein.`)
    }
    if ('code_blocks' in question) {
      if (!Array.isArray(question.code_blocks))
        errors.push(`${prefix}: code_blocks muss eine Liste sein.`)
      else
        for (const block of question.code_blocks) {
          if (
            !object(block) ||
            !validCode(block.code) ||
            ('filename' in block && typeof block.filename !== 'string') ||
            ('start_line' in block && !positiveInteger(block.start_line))
          )
            errors.push(`${prefix}: Ein Codeblock ist ungültig.`)
        }
    }
    if (kind === 'multiple_choice' || kind === 'multi_select' || kind === 'ranking') {
      const options = question.options
      if (!Array.isArray(options) || !options.length)
        errors.push(`${prefix}: Antwortoptionen fehlen.`)
      else {
        const values: (string | number)[] = []
        let valid = true
        for (const option of options) {
          if (typeof option === 'string') values.push(option)
          else if (
            object(option) &&
            typeof option.label === 'string' &&
            (typeof option.value === 'string' ||
              (typeof option.value === 'number' && Number.isFinite(option.value)))
          )
            values.push(option.value)
          else valid = false
        }
        if (!valid || new Set(values).size !== values.length) {
          errors.push(`${prefix}: Antwortoptionen brauchen eindeutige Werte und Text.`)
        }
      }
    }
  })
  return errors
}

/** Reserve hidden snippets' numbers so existing answers never change meaning. */
export function numberCodeQuestions(questions: Question[], startLine = 1): Question[] {
  let nextLine = Number.isSafeInteger(startLine) && startLine > 0 ? startLine : 1
  return questions.map((question) => {
    if (question.code_blocks?.length) {
      const code_blocks = question.code_blocks.map((block) => {
        const explicit = block.start_line
        const start_line =
          explicit !== undefined && Number.isSafeInteger(explicit) && explicit > 0
            ? explicit
            : nextLine
        nextLine = start_line + codeLines(block.code, true).length
        return { ...block, start_line }
      })
      return { ...question, code_blocks }
    }
    const matrix =
      question.type === 'multiple_choice' && question.matrix && question.options?.length
    const count = question.code && !matrix ? codeLines(question.code).length : 0
    if (!count) return question
    const explicit = question.code_start_line
    const firstLine =
      explicit !== undefined && Number.isSafeInteger(explicit) && explicit > 0 ? explicit : nextLine
    nextLine = firstLine + count
    return { ...question, code_start_line: firstLine }
  })
}

function matches(answer: unknown, expected: unknown): boolean {
  if (Array.isArray(answer)) return answer.includes(expected)
  return answer === expected
}

export function visibleQuestionIds(questions: Question[], answers: Answers): Set<string> {
  const byId = new Map(questions.filter((q) => q.id).map((q) => [q.id, q]))
  const visible = new Set(byId.keys())

  let changed = true
  while (changed) {
    changed = false
    for (const [id, q] of byId) {
      if (!q.show_if || !visible.has(id)) continue
      const trigger = q.show_if.question
      const ok = visible.has(trigger) && matches(answers[trigger], q.show_if.equals)
      if (!ok) {
        visible.delete(id)
        changed = true
      }
    }
  }
  return visible
}

function answered(v: unknown): boolean {
  if (v === null || v === undefined) return false
  if (typeof v === 'string') return v.trim() !== ''
  if (Array.isArray(v)) return v.length > 0
  return true
}

export function missingRequired(questions: Question[], answers: Answers): string[] {
  const visible = visibleQuestionIds(questions, answers)
  return questions
    .filter((q) => {
      if (!q.id || !visible.has(q.id)) return false
      const value = answers[q.id]
      if (q.type === 'multi_select') {
        if (value === undefined) return q.required !== false
        return !validMultiSelect(q, value) || (q.required !== false && value.length === 0)
      }
      if (q.type === 'line_numbers') {
        const omitted = value == null || (Array.isArray(value) && value.length === 0)
        return omitted ? q.required !== false : !validLineNumbers(q, value)
      }
      if (q.type === 'debugging') {
        return value == null ? q.required !== false : !validDebuggingAnswer(q, value)
      }
      if (q.type === 'ranking') {
        return value == null ? q.required !== false : !validRanking(q, value)
      }
      if (!answered(value)) return q.required !== false
      return false
    })
    .map((q) => q.id)
}

/** One error can refer to several code lines; older answers may hold just one. */
export function validLineNumbers(question: Question, value: unknown): boolean {
  const lines = Array.isArray(value) ? value : [value]
  const min = Math.max(1, question.min ?? 1)
  const maxEntries = lineEntryLimit(question)
  return (
    lines.length > 0 &&
    (maxEntries === undefined || lines.length <= maxEntries) &&
    lines.every(
      (line) =>
        typeof line === 'number' &&
        Number.isSafeInteger(line) &&
        line >= min &&
        (question.max === undefined || line <= question.max),
    )
  )
}

export function lineEntryLimit(question: Question): number | undefined {
  return question.max_entries ?? (question.type === 'debugging' ? 5 : undefined)
}

export function validDebuggingAnswer(question: Question, value: unknown): value is DebuggingAnswer {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const answer = value as Record<string, unknown>
  return (
    Object.keys(answer).every((key) => key === 'lines' || key === 'explanation') &&
    Array.isArray(answer.lines) &&
    validLineNumbers(question, answer.lines) &&
    typeof answer.explanation === 'string' &&
    answer.explanation.trim() !== ''
  )
}

export function validRanking(question: Question, value: unknown): value is (string | number)[] {
  const options = (question.options ?? []).map(normaliseOption).map((option) => option.value)
  return (
    options.length > 0 &&
    options.every(
      (option) =>
        typeof option === 'string' || (typeof option === 'number' && Number.isFinite(option)),
    ) &&
    new Set(options).size === options.length &&
    Array.isArray(value) &&
    value.length === options.length &&
    new Set(value).size === value.length &&
    value.every((option) => options.includes(option))
  )
}

/** Checkbox selections retain authored value types; an empty selection is valid input. */
export function validMultiSelect(question: Question, value: unknown): value is (string | number)[] {
  const options = (question.options ?? []).map(normaliseOption).map((option) => option.value)
  return (
    options.length > 0 &&
    options.every(
      (option) =>
        typeof option === 'string' || (typeof option === 'number' && Number.isFinite(option)),
    ) &&
    new Set(options).size === options.length &&
    Array.isArray(value) &&
    new Set(value).size === value.length &&
    value.every((option) => options.includes(option))
  )
}

export function invalidPartialAnswers(questions: Question[], answers: Answers): string[] {
  const visible = visibleQuestionIds(questions, answers)
  const partialLines = (question: Question, value: unknown): boolean => {
    const lines = Array.isArray(value) ? value : [value]
    const limit = lineEntryLimit(question)
    const filled = lines.filter((line) => line != null)
    return (
      (limit === undefined || lines.length <= limit) &&
      (filled.length === 0 || validLineNumbers(question, filled))
    )
  }
  return questions
    .filter((question) => {
      const value = answers[question.id]
      if (!visible.has(question.id) || value === undefined) return false
      if (question.type === 'multi_select') return !validMultiSelect(question, value)
      if (value === null) return false
      if (question.type === 'debugging') {
        if (typeof value !== 'object' || Array.isArray(value)) return true
        const answer = value as Record<string, unknown>
        return (
          Object.keys(answer).some((key) => key !== 'lines' && key !== 'explanation') ||
          (answer.explanation != null && typeof answer.explanation !== 'string') ||
          (answer.lines != null &&
            (!Array.isArray(answer.lines) || !partialLines(question, answer.lines)))
        )
      }
      if (question.type === 'line_numbers') return !partialLines(question, value)
      if (question.type === 'ranking') return !validRanking(question, value)
      if (question.type === 'free_text') return typeof value !== 'string'
      return false
    })
    .map((question) => question.id)
}

export function normaliseOption(opt: string | QuestionOption): QuestionOption {
  return typeof opt === 'string' ? { value: opt, label: opt } : opt
}

export type QuestionBlock =
  | { kind: 'single'; question: Question }
  | { kind: 'matrix'; key: string; options: QuestionOption[]; questions: Question[] }

/**
 * Group the questions a screen is about to show into what gets rendered: a
 * run of single-choice questions sharing a `matrix` key and identical options
 * becomes one table; everything else stays a question of its own. A run is
 * broken by any other question in between, and by a change of options — two
 * ladders with different statements are two tables.
 */
function sameOptions(a: QuestionOption[], b: QuestionOption[]): boolean {
  // Compared field by field rather than by serialising: the admin types this
  // JSON by hand, so two identical ladders can differ in key order or carry a
  // stray key, and a run that split there would repeat the whole legend.
  return (
    a.length === b.length && a.every((o, i) => o.value === b[i].value && o.label === b[i].label)
  )
}

export function groupQuestions(questions: Question[]): QuestionBlock[] {
  const blocks: QuestionBlock[] = []
  for (const q of questions) {
    const options =
      q.type === 'multiple_choice' && q.matrix ? (q.options ?? []).map(normaliseOption) : null
    const last = blocks[blocks.length - 1]
    if (
      options?.length &&
      last?.kind === 'matrix' &&
      last.key === q.matrix &&
      sameOptions(last.options, options)
    ) {
      last.questions.push(q)
    } else if (options?.length) {
      blocks.push({ kind: 'matrix', key: q.matrix as string, options, questions: [q] })
    } else {
      blocks.push({ kind: 'single', question: q })
    }
  }
  return blocks
}
