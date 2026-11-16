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

export interface PilotPosition {
  phase: 'questionnaire' | 'video' | 'discussion'
  current?: number
  total?: number
}

export function pilotPositionAt(steps: SessionStep[], index: number): PilotPosition {
  const step = steps[index]
  const cases = steps.filter((item) => item.kind === 'case_intro')
  const total = cases.length
  if (step?.kind === 'think_aloud')
    return { phase: 'discussion', current: step.case_number, total: step.case_total ?? total }
  if (step?.kind === 'text_page') {
    if (['discussion_start', 'post_intro'].includes(step.key)) return { phase: 'discussion' }
    if (['video_start', 'video_intro', 'video_end'].includes(step.key))
      return { phase: 'video', current: step.key === 'video_end' ? total : 1, total }
    return { phase: 'questionnaire' }
  }
  if (step && ['case_intro', 'case_video', 'diagnosis', 'case_outro'].includes(step.kind)) {
    return {
      phase: 'video',
      current: step.case_number ?? cases.filter((item) => item.index <= index).length,
      total: step.case_total ?? total,
    }
  }
  if (step?.kind === 'thanks' || (step?.kind === 'sosci' && step.variant === 'posttest'))
    return { phase: 'discussion' }
  return { phase: 'questionnaire' }
}
