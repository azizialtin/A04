// Frontend half of the questionnaire contract; mirrors the backend engine in
// app/services/questionnaires.py — keep the two in step.

import { codeLines } from './code'

export type QuestionType =
  'likert' | 'multiple_choice' | 'free_text' | 'slider' | 'number' | 'line_numbers'

export interface QuestionOption {
  value: string | number
  label: string
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
}

export type Answers = Record<string, unknown>

/** Reserve hidden snippets' numbers so existing answers never change meaning. */
export function numberCodeQuestions(questions: Question[], startLine = 1): Question[] {
  let nextLine = Number.isSafeInteger(startLine) && startLine > 0 ? startLine : 1
  return questions.map((question) => {
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
      if (q.type === 'line_numbers') {
        const omitted = value == null || (Array.isArray(value) && value.length === 0)
        return omitted ? q.required !== false : !validLineNumbers(q, value)
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
  return (
    lines.length > 0 &&
    lines.every(
      (line) =>
        typeof line === 'number' &&
        Number.isSafeInteger(line) &&
        line >= min &&
        (question.max === undefined || line <= question.max),
    )
  )
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
