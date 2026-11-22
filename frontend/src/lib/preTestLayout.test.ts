import { expect, test } from 'vitest'

import { preTestLayout } from './preTestLayout'
import type { Question } from './questionnaire'

const rating = (id: string, extra: Partial<Question> = {}): Question =>
  ({
    id,
    type: 'multiple_choice',
    text: id,
    matrix: 'ratings',
    matrix_prompt: 'Wie plausibel?',
    options: [1, 2, 3, 4, 5, 6].map((value) => ({ value, label: `Stufe ${value}` })),
    ...extra,
  }) as Question
const text = (id: string, extra: Partial<Question> = {}): Question =>
  ({ id, type: 'free_text', text: id, ...extra }) as Question

const layout = (
  sectionKey: string,
  questions: Question[],
  { pilot = true, description = '' } = {},
) => preTestLayout({ pilot, sectionKey, questions, description })

test('a revised PCK page is one item group under its stimulus, with labelled columns', () => {
  const page = layout('pck', [rating('pck_pre_1b_1'), rating('pck_pre_1b_2')])
  expect(page.className).toBe('pretest-page pretest-page--pilot pretest-page--pck-item')
  expect(page.layout).toBe('stimulus')
  expect(page.matrixLabels).toBe('headers')
  // It has a layout of its own, so the generic wide-matrix fitting stays off.
  expect(page.className).not.toContain('pretest-page--matrix')
})

test('a first-pilot PCK page keeps its authored columns', () => {
  const page = layout('pck', [
    text('pck_pre_1a', { layout_column: 1 }),
    rating('pck_pre_1b_1', { layout_column: 2 }),
    rating('pck_pre_1c_1', { layout_column: 3 }),
  ])
  expect(page.className).toBe('pretest-page pretest-page--pilot pretest-page--pck')
  expect(page.layout).toBe('columns')
  expect(page.matrixLabels).toBeUndefined()
})

test('one authored column is enough to keep the first pilot layout', () => {
  const page = layout('pck', [text('a'), rating('b', { layout_column: 2 })])
  expect(page.className).toContain('pretest-page--pck')
  expect(page.className).not.toContain('pretest-page--pck-item')
})

test('outside the pilot flow a PCK page has no pilot layout', () => {
  const page = layout('pck', [rating('pck_pre_1b_1')], { pilot: false })
  expect(page.className).toBe('pretest-page pretest-page--pck pretest-page--matrix')
  expect(page.layout).toBeUndefined()
  expect(page.matrixLabels).toBeUndefined()
})

test('the timed CK pages are marked, and nothing else about them changes', () => {
  const page = layout('ck_tasks', [text('ck_pre_01')])
  expect(page.timed).toBe(true)
  expect(page.className).toBe('pretest-page pretest-page--pilot pretest-page--ck')
  expect(page.layout).toBeUndefined()
  expect(layout('pck', [text('a')]).timed).toBe(false)
})

test('MESP rating pages carry their labels in the column heads', () => {
  const page = layout('mesp', [rating('mesp_pre_1a'), rating('mesp_pre_1b')])
  expect(page.className).toBe(
    'pretest-page pretest-page--pilot pretest-page--mesp pretest-page--matrix',
  )
  expect(page.matrixLabels).toBe('headers')
  expect(layout('mesp', [rating('m')], { pilot: false }).matrixLabels).toBeUndefined()
})

test('a rating page with a long instruction makes room for it', () => {
  const long = layout('', [rating('a')], { description: 'x'.repeat(801) })
  expect(long.className).toBe(
    'pretest-page pretest-page--pilot pretest-page--matrix pretest-page--instructions',
  )
  const short = layout('', [rating('a')], { description: 'x'.repeat(800) })
  expect(short.className).not.toContain('pretest-page--instructions')
  // A page that mixes ratings with other questions is not a rating page.
  expect(layout('', [rating('a'), text('b')]).className).toBe('pretest-page pretest-page--pilot')
})

test('demographics are recognised by section or by their questions', () => {
  expect(layout('demographics', [text('anything')]).className).toContain(
    'pretest-page--demographics',
  )
  const byQuestions = layout('', [text('participant_group'), text('sex'), text('age')])
  expect(byQuestions.className).toContain('pretest-page--demographics')
  // A form the researchers replaced stays in ordinary flow.
  expect(byQuestions.demographicsForm).toBeNull()
  expect(byQuestions.layout).toBeUndefined()
  expect(layout('', [text('sex'), text('age')]).className).not.toContain('demographics')
})

test('the standard demographics form is split into its two pages of columns', () => {
  const ids = [
    'sex',
    'age',
    'participant_group',
    'st_degree',
    'st_enrollment',
    'st_subject',
    'st_semester',
    'st_schulform',
    'dupl1_st_schulform',
    'st_fach1',
    'st_fach2',
    'st_fach3',
    'st_schulpraktikum',
    'st_unterricht',
    'teach_class',
    'teach_inf_ex',
    'teach_inf_year',
    'teach_prog_ex',
    'teach_prog_year',
    'java_ex',
    'java_years',
  ]
  const page = layout(
    'demographics',
    ids.map((id) => text(id)),
  )
  expect(page.layout).toBe('columns')
  expect(page.demographicsForm?.pages).toHaveLength(2)
  expect(page.demographicsForm?.questions.map((question) => question.id)).toEqual(ids)
})

test('an empty page is just a page', () => {
  expect(layout('', [], { pilot: false })).toMatchObject({
    className: 'pretest-page',
    layout: undefined,
    matrixLabels: undefined,
    demographicsForm: null,
    timed: false,
  })
})
