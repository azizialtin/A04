import type { Question } from './questionnaire'
import { groupQuestions, missingRequired, visibleQuestionIds } from './questionnaire'

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

test('a run of matrix questions with the same options is one block; anything else breaks it', () => {
  const ladder = ['nie', 'manchmal', 'oft']
  const other = ['ja', 'nein']
  const blocks = groupQuestions([
    { id: 'a', type: 'multiple_choice', text: 'A', options: ladder, matrix: 'm' },
    { id: 'b', type: 'multiple_choice', text: 'B', options: ladder, matrix: 'm' },
    { id: 'c', type: 'multiple_choice', text: 'C', options: other, matrix: 'm' },
    { id: 'd', type: 'free_text', text: 'D' },
    { id: 'e', type: 'multiple_choice', text: 'E', options: ladder, matrix: 'm' },
    { id: 'f', type: 'multiple_choice', text: 'F', options: ladder },
  ])

  expect(
    blocks.map((b) => (b.kind === 'matrix' ? b.questions.map((q) => q.id) : b.question.id)),
  ).toEqual([
    ['a', 'b'], // same key, same options
    ['c'], // same key, different options: its own table
    'd',
    ['e'], // the free-text question broke the run
    'f', // no key: an ordinary question, even with the same options
  ])
})
