import { demographicsLayout } from './demographicsLayout'
import type { Question } from './questionnaire'

/**
 * How a pre-test page is laid out: the classes on the page and what the
 * renderer is told. Decided in one place, because the researcher's preview has
 * to show a page the way the participant will see it.
 */
export function preTestLayout({
  pilot,
  sectionKey,
  questions,
  description,
}: {
  pilot: boolean
  sectionKey: string
  questions: Question[]
  description: string
}) {
  const timed = sectionKey === 'ck_tasks'
  const pck = sectionKey === 'pck'
  // The revised PCK pages hold one item group each. The first pilot's pages
  // carry authored columns and keep that layout.
  const pckItem = pilot && pck && questions.every((question) => !question.layout_column)
  const matrixPage = questions.length > 0 && questions.every((question) => question.matrix)
  const demographics =
    sectionKey === 'demographics' ||
    ['participant_group', 'sex', 'age'].every((id) =>
      questions.some((question) => question.id === id),
    )
  const demographicsForm = demographics ? demographicsLayout(questions) : null
  const layout: 'columns' | 'stimulus' | undefined = pckItem
    ? 'stimulus'
    : demographicsForm || (pilot && pck)
      ? 'columns'
      : undefined
  const matrixLabels: 'headers' | undefined =
    (pilot && sectionKey === 'mesp') || pckItem ? 'headers' : undefined
  return {
    timed,
    demographicsForm,
    layout,
    matrixLabels,
    className: [
      'pretest-page',
      pilot && 'pretest-page--pilot',
      timed && 'pretest-page--ck',
      pck && (pckItem ? 'pretest-page--pck-item' : 'pretest-page--pck'),
      pilot && sectionKey === 'mesp' && 'pretest-page--mesp',
      // The generic wide-matrix fitting is for pages without a layout of their own.
      matrixPage && !pckItem && 'pretest-page--matrix',
      matrixPage && !pckItem && description.length > 800 && 'pretest-page--instructions',
      demographics && 'pretest-page--demographics',
    ]
      .filter(Boolean)
      .join(' '),
  }
}
