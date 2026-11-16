import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import type { SessionStep } from '../../api/participant'
import i18n from '../../i18n'
import de from '../../i18n/locales/de.json'
import en from '../../i18n/locales/en.json'
import TextPageScreen from './TextPageScreen'

const postIntro: Extract<SessionStep, { kind: 'text_page' }> = {
  kind: 'text_page',
  index: 67,
  completed: false,
  key: 'post_intro',
  title: '',
  body: '',
}

afterEach(async () => {
  await act(async () => {
    await i18n.changeLanguage('de')
  })
})

test.each([
  ['de', de],
  ['en', en],
] as const)(
  'the default final introduction shows only its body and continuation in %s',
  async (language, locale) => {
    await act(async () => {
      await i18n.changeLanguage(language)
    })
    const onContinue = vi.fn()
    const { container } = render(
      <TextPageScreen step={postIntro} busy={false} onContinue={onContinue} />,
    )
    expect(screen.queryByRole('heading')).not.toBeInTheDocument()
    expect(container.querySelector('h1')).toBeNull()
    for (const paragraph of locale.pilot.text_pages.post_intro.body.split('\n\n')) {
      expect(screen.getByText(paragraph)).toBeInTheDocument()
    }
    fireEvent.click(screen.getByRole('button', { name: locale.common.continue }))
    expect(onContinue).toHaveBeenCalledOnce()
  },
)

test('the final introduction honors an explicit researcher title', () => {
  render(
    <TextPageScreen
      step={{ ...postIntro, title: 'Eigene Überschrift' }}
      busy={false}
      onContinue={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Eigene Überschrift', level: 1 })).toBeInTheDocument()
  expect(screen.getByText(de.pilot.text_pages.post_intro.body.split('\n\n')[0])).toBeInTheDocument()
})

test('other text pages retain their default headings', () => {
  render(
    <TextPageScreen step={{ ...postIntro, key: 'video_start' }} busy={true} onContinue={vi.fn()} />,
  )
  expect(
    screen.getByRole('heading', { name: de.pilot.text_pages.video_start.title, level: 1 }),
  ).toBeInTheDocument()
  expect(screen.getByText(de.pilot.text_pages.video_start.body)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
})
