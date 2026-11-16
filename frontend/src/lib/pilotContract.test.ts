import { describe, expect, test } from 'vitest'
import i18n from '../i18n'
import type { SessionStep } from '../api/participant'
import {
  definitionErrors,
  invalidPartialAnswers,
  missingRequired,
  validDebuggingAnswer,
  validMultiSelect,
  type Question,
} from './questionnaire'
import { pilotPositionAt } from './sessionProgress'
import { stepLabel } from './stepBack'

const pickTwo: Question = {
  id: 'pck_pre_3b',
  type: 'multi_select',
  text: 'Genau zwei',
  options: ['a', 'b', 'c', 'd'],
  min_selections: 2,
  max_selections: 2,
}
const debugging: Question = {
  id: 'ck_pre_01',
  type: 'debugging',
  text: 'Fehler',
  min: 1,
  max: 20,
  allow_skip: true,
}

describe('pilot response contract', () => {
  test('pick-two validates exact cardinality without weakening legacy checkbox types', () => {
    expect(definitionErrors([pickTwo])).toEqual([])
    for (const answer of [[], ['a'], ['a', 'b', 'c'], ['a', 'a'], ['a', 'unknown']])
      expect(validMultiSelect(pickTwo, answer)).toBe(false)
    expect(validMultiSelect(pickTwo, ['a', 'd'])).toBe(true)
    expect(invalidPartialAnswers([pickTwo], { pck_pre_3b: ['a'] })).toEqual([])
    expect(invalidPartialAnswers([pickTwo], { pck_pre_3b: ['a', 'b', 'c'] })).toEqual([
      'pck_pre_3b',
    ])
    expect(missingRequired([pickTwo], { pck_pre_3b: ['a'] })).toEqual(['pck_pre_3b'])
    expect(
      validMultiSelect({ ...pickTwo, min_selections: undefined, max_selections: undefined }, [
        'a',
        'b',
        'c',
      ]),
    ).toBe(true)
    for (const invalid of [
      { min_selections: 3, max_selections: 2 },
      { min_selections: 5 },
      { max_selections: 2.5 },
    ])
      expect(definitionErrors([{ ...pickTwo, ...invalid }]).length).toBeGreaterThan(0)
  })
  test('only the explicit allowed skip can bypass positive line and explanation validation', () => {
    const skip = { lines: [0], explanation: '', skipped: true }
    expect(validDebuggingAnswer(debugging, skip)).toBe(true)
    expect(invalidPartialAnswers([debugging], { ck_pre_01: skip })).toEqual([])
    for (const invalid of [
      { lines: [0], explanation: '' },
      { ...skip, explanation: '-' },
      { ...skip, lines: [1] },
      { ...skip, skipped: false },
      { ...skip, extra: true },
    ])
      expect(validDebuggingAnswer(debugging, invalid)).toBe(false)
    expect(validDebuggingAnswer({ ...debugging, allow_skip: false }, skip)).toBe(false)
    expect(validDebuggingAnswer(debugging, { lines: [1], explanation: 'explanation' })).toBe(true)
  })
})

test('pilot numbering spans pre, training and post and does not leak those phase names', () => {
  const raw: Partial<SessionStep>[] = [
    { kind: 'welcome' },
    { kind: 'text_page', key: 'video_intro' },
    { kind: 'case_intro', phase_type: 'pre_test', case_number: 1, case_total: 3 },
    { kind: 'case_video', case_number: 1, case_total: 3 },
    { kind: 'case_intro', phase_type: 'training', case_number: 2, case_total: 3 },
    { kind: 'case_intro', phase_type: 'post_test', case_number: 3, case_total: 3 },
    { kind: 'text_page', key: 'video_end' },
    { kind: 'think_aloud', case_number: 2, case_total: 3 },
    { kind: 'text_page', key: 'post_intro' },
    { kind: 'sosci', variant: 'posttest' },
  ]
  const steps = raw.map((item, index) => ({ ...item, index, completed: false }) as SessionStep)
  expect(pilotPositionAt(steps, 0)).toEqual({ phase: 'questionnaire' })
  expect(pilotPositionAt(steps, 1)).toEqual({ phase: 'video', current: 1, total: 3 })
  expect(pilotPositionAt(steps, 4)).toEqual({ phase: 'video', current: 2, total: 3 })
  expect(pilotPositionAt(steps, 5)).toEqual({ phase: 'video', current: 3, total: 3 })
  expect(pilotPositionAt(steps, 6)).toEqual({ phase: 'video', current: 3, total: 3 })
  expect(pilotPositionAt(steps, 7)).toEqual({ phase: 'discussion', current: 2, total: 3 })
  expect(pilotPositionAt(steps, 8)).toEqual({ phase: 'discussion' })
  expect(pilotPositionAt(steps, 9)).toEqual({ phase: 'discussion' })
})

test('step-back suppresses video titles on every video-linked kind, even legacy payloads', () => {
  for (const kind of ['case_video', 'diagnosis', 'think_aloud'] as const) {
    const step = { kind, title: 'Secret answer-bearing title', case_number: 5 } as SessionStep
    expect(stepLabel(step, i18n.t)).not.toContain('Secret')
    expect(stepLabel(step, i18n.t)).toContain('Fall 5')
  }
})
