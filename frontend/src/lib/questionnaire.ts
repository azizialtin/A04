// Frontend half of the questionnaire contract; mirrors the backend engine in
// app/services/questionnaires.py — keep the two in step.

export type QuestionType = 'likert' | 'multiple_choice' | 'free_text' | 'slider' | 'number'

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
}

export type Answers = Record<string, unknown>

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
    .filter((q) => q.id && visible.has(q.id) && q.required !== false && !answered(answers[q.id]))
    .map((q) => q.id)
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
