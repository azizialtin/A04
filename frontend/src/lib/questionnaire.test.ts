import type { Question } from './questionnaire'
import { missingRequired, visibleQuestionIds } from './questionnaire'

test('required field must be answered', () => {
  const qs: Question[] = [{ id: 'a', type: 'free_text', text: 'why' }]
  expect(missingRequired(qs, {})).toEqual(['a'])
  expect(missingRequired(qs, { a: 'because' })).toEqual([])
})

test('optional field is never missing', () => {
  const qs: Question[] = [{ id: 'a', type: 'free_text', text: 'why', required: false }]
  expect(missingRequired(qs, {})).toEqual([])
})

test('show_if gates the requirement', () => {
  const qs: Question[] = [
    { id: 'a', type: 'likert', text: 'a' },
    { id: 'b', type: 'free_text', text: 'b', show_if: { question: 'a', equals: 3 } },
  ]
  expect(missingRequired(qs, { a: 1 })).toEqual([])
  expect(missingRequired(qs, { a: 3 })).toEqual(['b'])
})

test('show_if resolves transitively', () => {
  const qs: Question[] = [
    { id: 'a', type: 'likert', text: 'a' },
    { id: 'b', type: 'free_text', text: 'b', show_if: { question: 'a', equals: 1 } },
    { id: 'c', type: 'free_text', text: 'c', show_if: { question: 'b', equals: 'yes' } },
  ]
  const hidden = visibleQuestionIds(qs, { a: 2 })
  expect(hidden.has('b')).toBe(false)
  expect(hidden.has('c')).toBe(false)
  expect(visibleQuestionIds(qs, { a: 1, b: 'yes' })).toEqual(new Set(['a', 'b', 'c']))
})
