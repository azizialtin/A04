import type { Question } from './questionnaire'
import {
  groupQuestions,
  missingRequired,
  validLineNumbers,
  visibleQuestionIds,
} from './questionnaire'

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

const lines: Question = { id: 'lines', type: 'line_numbers', text: 'Which lines?', min: 3, max: 10 }

test('line references accept several lines and restore an older scalar answer', () => {
  expect(missingRequired([lines], { lines: [3, 5, 10] })).toEqual([])
  expect(missingRequired([lines], { lines: 5 })).toEqual([])
  expect(validLineNumbers(lines, [3, 3, 4, 5, 6, 7, 8])).toBe(true)
})

test.each(
  [[], [undefined], [null], [3, 0], [2], [11], [3.5], ['3'], [true], {}, ''].map((value) => ({
    value,
  })),
)('rejects incomplete or invalid line references: %j', ({ value }) => {
  expect(missingRequired([lines], { lines: value })).toEqual(['lines'])
})

test('optional line references may be omitted but supplied references must be valid', () => {
  const optional = { ...lines, required: false }
  expect(missingRequired([optional], {})).toEqual([])
  expect(missingRequired([optional], { lines: [] })).toEqual([])
  expect(missingRequired([optional], { lines: [0] })).toEqual(['lines'])
  expect(missingRequired([optional], { lines: {} })).toEqual(['lines'])
  expect(missingRequired([optional], { lines: '' })).toEqual(['lines'])
})

test('hidden line references do not block a page and positive whole numbers are the default', () => {
  const gated = { ...lines, show_if: { question: 'other', equals: 1 } }
  expect(missingRequired([gated], { lines: [0] })).toEqual([])
  const unbounded: Question = { id: 'lines', type: 'line_numbers', text: 'Lines' }
  expect(validLineNumbers(unbounded, [1, 1_000])).toBe(true)
  expect(validLineNumbers(unbounded, [-1, 0])).toBe(false)
  expect(validLineNumbers(unbounded, [Number.POSITIVE_INFINITY])).toBe(false)
})
