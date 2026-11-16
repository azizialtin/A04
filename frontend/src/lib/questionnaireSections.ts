import type { AdminQuestionnaire } from '../api/admin'

export const QUESTIONNAIRE_INSTRUMENTS = [
  { key: 'demographics', name: 'Demographics/participants', description: 'Angaben zur Person' },
  {
    key: 'ck_self',
    name: 'ck_pre_self',
    description: 'Selbsteinschätzung Programmierung & Debugging',
  },
  { key: 'ck_tasks', name: 'ck_pre', description: 'Fachwissen Debugging' },
  { key: 'pck', name: 'pck_pre', description: 'Fachdidaktisches Wissen' },
  { key: 'msk', name: 'msk_pre', description: 'Metakognitives Strategiewissen' },
] as const

export function instrumentName(key: string | undefined): string {
  return QUESTIONNAIRE_INSTRUMENTS.find((instrument) => instrument.key === key)?.name || key || '—'
}

export function hasIntroduction(page: AdminQuestionnaire): boolean {
  // Existing whitespace-only text still creates a step in the session script.
  return Boolean(page.intro_title || page.intro_body)
}

/** Match the session script: empty pages do not appear or split sections. */
export function questionnaireSections(pages: AdminQuestionnaire[]) {
  const ordered = pages
    .filter((page) => page.placement === 'pre_test')
    .sort((a, b) => a.order_index - b.order_index || a.id - b.id)
  const active = ordered.filter((page) => page.questions.length > 0)
  const keys = [
    ...new Set([
      ...QUESTIONNAIRE_INSTRUMENTS.map(({ key }) => key),
      ...ordered.map((page) => page.section_key || '').filter(Boolean),
    ]),
  ]
  return keys.map((key) => {
    const members = ordered.filter((page) => page.section_key === key)
    const populated = active.filter((page) => page.section_key === key)
    const first = populated[0]
    const start = first ? active.indexOf(first) : -1
    const consecutive = populated.every((page, index) => active[start + index] === page)
    return {
      key,
      name: instrumentName(key),
      description:
        QUESTIONNAIRE_INSTRUMENTS.find((instrument) => instrument.key === key)?.description ||
        members[0]?.section ||
        '',
      pages: members,
      populated,
      first,
      consecutive,
      misplacedIntro: members.some((page) => page !== first && hasIntroduction(page)),
    }
  })
}
