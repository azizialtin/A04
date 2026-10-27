import type { Question } from './questionnaire'
import {
  groupQuestions,
  definitionErrors,
  invalidPartialAnswers,
  missingRequired,
  validLineNumbers,
  visibleQuestionIds,
} from './questionnaire'

test('required field must be answered', () => {
  const qs: Question[] = [{ id: 'a', type: 'free_text', text: 'why' }]
  expect(missingRequired(qs, {})).toEqual(['a'])
  expect(missingRequired(qs, { a: 'because' })).toEqual([])
})

const multiSelect: Question = {
  id: 'multi',
  type: 'multi_select',
  text: 'Welche Maßnahmen?',
  options: [{ value: 1, label: 'Zahl' }, { value: '1', label: 'Text' }, 'trace'],
}

test('multi-select requires a nonempty typed subset, while optional and partial answers permit empty selections', () => {
  expect(missingRequired([multiSelect], {})).toEqual(['multi'])
  expect(missingRequired([multiSelect], { multi: [] })).toEqual(['multi'])
  expect(missingRequired([multiSelect], { multi: [1, '1'] })).toEqual([])
  const optional = { ...multiSelect, required: false }
  expect(missingRequired([optional], {})).toEqual([])
  expect(missingRequired([optional], { multi: [] })).toEqual([])
  expect(invalidPartialAnswers([multiSelect], {})).toEqual([])
  expect(invalidPartialAnswers([multiSelect], { multi: [] })).toEqual([])
  expect(invalidPartialAnswers([multiSelect], { multi: ['trace', 1] })).toEqual([])
  for (const value of [
    null,
    1,
    '1',
    {},
    [1, 1],
    ['unknown'],
    [true],
    [null],
    [[]],
    [NaN],
    [Infinity],
  ]) {
    expect(missingRequired([optional], { multi: value })).toEqual(['multi'])
    expect(invalidPartialAnswers([multiSelect], { multi: value })).toEqual(['multi'])
  }
})

test('multi-select definitions need unique typed options and selections drive conditional visibility', () => {
  expect(definitionErrors([multiSelect])).toEqual([])
  for (const options of [undefined, [], ['a', 'a'], [{ value: true, label: 'Boolean' }], [1]]) {
    expect(definitionErrors([{ ...multiSelect, options }])).not.toEqual([])
  }
  const followup: Question = {
    id: 'why',
    type: 'free_text',
    text: 'Warum?',
    show_if: { question: 'multi', equals: '1' },
  }
  expect(missingRequired([multiSelect, followup], { multi: [1] })).toEqual([])
  expect(missingRequired([multiSelect, followup], { multi: ['1'] })).toEqual(['why'])
})

test('an entry cap counts locations independently of the valid code-line range', () => {
  const capped = { ...lines, max_entries: 5 }
  expect(missingRequired([capped], { lines: [3, 4, 5, 6, 10] })).toEqual([])
  expect(missingRequired([capped], { lines: [3, 4, 5, 6, 7, 8] })).toEqual(['lines'])
  expect(validLineNumbers(lines, [3, 4, 5, 6, 7, 8])).toBe(true)
})

const debugging: Question = { id: 'ck', type: 'debugging', text: 'Fehler?', min: 1, max: 29 }

test('debugging requires both components and defaults to five locations', () => {
  expect(missingRequired([debugging], { ck: { lines: [6], explanation: 'Falscher Typ' } })).toEqual(
    [],
  )
  for (const value of [
    {},
    { lines: [6] },
    { explanation: 'Falscher Typ' },
    { lines: 6, explanation: 'Falscher Typ' },
    { lines: [1, 2, 3, 4, 5, 6], explanation: 'Fehler' },
    { lines: [30], explanation: 'Fehler' },
    { lines: [6], explanation: '   ' },
    { lines: [6], explanation: 'Fehler', unexpected: true },
  ])
    expect(missingRequired([debugging], { ck: value })).toEqual(['ck'])
})

test('supervisor exit keeps incomplete components but rejects malformed values', () => {
  for (const value of [
    {},
    { lines: [6, null] },
    { explanation: 'Unfertig' },
    { lines: null, explanation: null },
  ]) {
    expect(invalidPartialAnswers([debugging], { ck: value })).toEqual([])
  }
  for (const value of [
    { lines: [0] },
    { lines: ['6'] },
    { lines: [null, null, null, null, null, null] },
    { explanation: 3 },
  ]) {
    expect(invalidPartialAnswers([debugging], { ck: value })).toEqual(['ck'])
  }
})

const ranking: Question = {
  id: 'order',
  type: 'ranking',
  text: 'Ordnen',
  options: [
    { value: 'inspect', label: 'Prüfen' },
    { value: 'test', label: 'Testen' },
    { value: 3, label: 'Korrigieren' },
  ],
}

test('ranking saves stable values and requires an exact permutation', () => {
  expect(missingRequired([ranking], { order: [3, 'test', 'inspect'] })).toEqual([])
  for (const value of [
    undefined,
    [],
    ['test'],
    ['test', 'test', 3],
    ['test', 'inspect', '3'],
    ['test', 'inspect', true],
  ]) {
    expect(missingRequired([ranking], { order: value })).toEqual(['order'])
  }
})

test('authored definitions reject invalid new fields and duplicate variable IDs', () => {
  expect(
    definitionErrors([
      debugging,
      ranking,
      {
        ...lines,
        max_entries: 5,
        code_blocks: [{ filename: 'A.java', code: ['', 'class A {', '}'], start_line: 1 }],
      },
    ]),
  ).toEqual([])
  expect(definitionErrors([debugging, debugging])).toContain(
    'Frage 2: Die ID ck ist doppelt vergeben.',
  )
  for (const max_entries of [0, -1, 2.5, true, '5', null]) {
    expect(definitionErrors([{ ...debugging, max_entries }])).not.toEqual([])
  }
  expect(definitionErrors([{ ...debugging, code_blocks: [{ code: [1] }] }])).not.toEqual([])
  expect(definitionErrors([{ ...ranking, options: ['x', 'x'] }])).not.toEqual([])
  expect(definitionErrors([{ ...debugging, type: {} }])).not.toEqual([])
})

test('definition validation rejects malformed or missing conditional references', () => {
  for (const show_if of [
    'yes',
    [],
    { question: 'absent', equals: true },
    { question: 'ck' },
    { question: '', equals: 1 },
  ]) {
    expect(definitionErrors([{ ...debugging, show_if }])).not.toEqual([])
  }
  expect(
    definitionErrors([
      { ...debugging, show_if: { question: 'trigger', equals: 1 } },
      { id: 'trigger', type: 'number', text: 'Trigger' },
    ]),
  ).toEqual([])
})

test('definition validation rejects reversed and noninteger Likert scales and nonfinite numbers', () => {
  for (const bounds of [
    { scale_min: 5, scale_max: 1 },
    { scale_min: 1.5 },
    { scale_max: Infinity },
  ]) {
    expect(
      definitionErrors([{ id: 'scale', type: 'likert', text: 'Scale', ...bounds }]),
    ).not.toEqual([])
  }
  expect(definitionErrors([{ id: 'n', type: 'number', text: 'N', min: Infinity }])).not.toEqual([])
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
