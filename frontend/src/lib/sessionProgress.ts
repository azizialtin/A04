import type { SessionStep } from '../api/participant'

export interface CasePosition {
  /** 'pre_test' | 'training' | 'post_test' — whatever the script assigned. */
  phaseType: string
  /** 1-based position of this case within its own phase. */
  current: number
  /** How many cases that phase holds. */
  total: number
}

/**
 * Which case a step belongs to, as the participant thinks of it: the phase and
 * the case's place inside that phase — not its index in the flat step script,
 * which counts every intro, questionnaire page and hand-off along the way.
 *
 * A `case_intro` opens a case and everything up to the next one belongs to it.
 * Steps before the first case — the pre-test pages — belong to none, and get
 * null.
 */
export function caseAt(steps: SessionStep[], index: number): CasePosition | null {
  const phases: string[] = []
  let phaseOfIndex: string | null = null
  let currentOfIndex = 0

  for (const step of steps) {
    if (step.kind !== 'case_intro') continue
    phases.push(step.phase_type)
    if (step.index <= index) {
      phaseOfIndex = step.phase_type
      currentOfIndex = phases.filter((p) => p === step.phase_type).length
    }
  }

  if (phaseOfIndex === null) return null
  return {
    phaseType: phaseOfIndex,
    current: currentOfIndex,
    total: phases.filter((p) => p === phaseOfIndex).length,
  }
}
