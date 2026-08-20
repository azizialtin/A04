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
