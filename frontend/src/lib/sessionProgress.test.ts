import type { SessionStep } from '../api/participant'
import { caseAt } from './sessionProgress'

// welcome, one pre-test page, then two pre-test cases and one training case,
// each case being intro → clip → diagnosis → outro → think-aloud.
function script(): SessionStep[] {
  const steps: Partial<SessionStep>[] = [{ kind: 'welcome' }, { kind: 'questionnaire' }]
  const cases: [string, number][] = [
    ['pre_test', 1],
    ['pre_test', 2],
    ['training', 3],
  ]
  for (const [phase_type, video_id] of cases) {
    steps.push({ kind: 'case_intro', phase_type, video_id })
    steps.push({ kind: 'case_video', video_id })
    steps.push({ kind: 'diagnosis', video_id })
    steps.push({ kind: 'case_outro', phase_type, video_id })
    steps.push({ kind: 'think_aloud', video_id })
  }
  steps.push({ kind: 'thanks' })
  return steps.map((s, index) => ({ ...s, index, completed: false }) as SessionStep)
}

test('caseAt has no case before the first one starts', () => {
  expect(caseAt(script(), 0)).toBeNull()
  expect(caseAt(script(), 1)).toBeNull()
})

test('caseAt numbers a case within its own phase, not the whole run', () => {
  const steps = script()
  expect(caseAt(steps, 2)).toEqual({ phaseType: 'pre_test', current: 1, total: 2 })
  expect(caseAt(steps, 8)).toEqual({ phaseType: 'pre_test', current: 2, total: 2 })
  // First case of the training phase — case 3 of the run, case 1 of its phase.
  expect(caseAt(steps, 12)).toEqual({ phaseType: 'training', current: 1, total: 1 })
})

test('caseAt holds the case across the steps that follow its intro', () => {
  const steps = script()
  for (const i of [3, 4, 5, 6]) {
    expect(caseAt(steps, i)).toEqual({ phaseType: 'pre_test', current: 1, total: 2 })
  }
})
