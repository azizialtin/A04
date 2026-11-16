import { expect, test } from 'vitest'

import type { AdminQuestionnaire } from '../api/admin'
import { hasIntroduction, questionnaireSections } from './questionnaireSections'

const page = (
  id: number,
  key: string,
  extra: Partial<AdminQuestionnaire> = {},
): AdminQuestionnaire => ({
  id,
  study_id: 1,
  title: `Page ${id}`,
  description: '',
  section: 'Stored section',
  placement: 'pre_test',
  section_key: key,
  order_index: id,
  questions: [{ id: `question_${id}`, type: 'free_text', text: 'Question' }],
  ...extra,
})

test('section navigation uses the first populated page in script order and retains identifiers', () => {
  const pages = [
    page(8, 'ck_tasks', { order_index: 4 }),
    page(3, 'ck_tasks', { order_index: 4, intro_body: 'Actual introduction' }),
    page(1, 'ck_tasks', { questions: [], intro_body: 'Unused introduction' }),
  ]
  const section = questionnaireSections(pages).find(({ key }) => key === 'ck_tasks')!
  expect(section.name).toBe('ck_pre')
  expect(section.first).toBe(pages[1])
  expect(section.populated.map(({ id }) => id)).toEqual([3, 8])
  expect(section.misplacedIntro).toBe(true)
  expect(section.consecutive).toBe(true)
  expect(pages.map(({ id }) => id)).toEqual([8, 3, 1])
  expect(section.first.section_key).toBe('ck_tasks')
  expect(section.first.section).toBe('Stored section')
})

test('empty and per-case pages do not split sections, but populated unassigned pages do', () => {
  const pages = [
    page(1, 'pck'),
    page(2, 'msk', { questions: [] }),
    page(3, '', { placement: 'diagnosis' }),
    page(4, 'pck'),
  ]
  expect(questionnaireSections(pages).find(({ key }) => key === 'pck')?.consecutive).toBe(true)
  pages.splice(2, 0, page(5, '', { order_index: 2.5 }))
  expect(questionnaireSections(pages).find(({ key }) => key === 'pck')?.consecutive).toBe(false)
})

test('custom sections and absent standard instruments remain distinguishable', () => {
  const sections = questionnaireSections([page(1, 'custom'), page(2, 'msk', { questions: [] })])
  expect(sections.find(({ key }) => key === 'custom')?.name).toBe('custom')
  expect(sections.find(({ key }) => key === 'msk')).toMatchObject({
    first: undefined,
    populated: [],
  })
  expect(sections.find(({ key }) => key === 'demographics')?.pages).toEqual([])
})

test.each(['intro_title', 'intro_body'] as const)(
  'existing whitespace-only %s still counts as an introduction in the session',
  (field) => {
    const sections = questionnaireSections([
      page(1, 'ck_self', { [field]: ' \n\t ' }),
      page(2, 'ck_self', { [field]: ' ' }),
    ])
    const section = sections.find(({ key }) => key === 'ck_self')!
    expect(hasIntroduction(section.first)).toBe(true)
    expect(section.misplacedIntro).toBe(true)
    expect(hasIntroduction(page(3, 'ck_self', { intro_title: '', intro_body: '' }))).toBe(false)
  },
)
