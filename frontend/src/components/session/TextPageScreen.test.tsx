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
  for (const paragraph of de.pilot.text_pages.video_start.body.split('\n\n')) {
    expect(screen.getByText(paragraph)).toBeInTheDocument()
  }
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
})

const paragraphs = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('p.lead')).map((paragraph) => paragraph.textContent)

test('the video phase opens with the full-screen reminder ahead of the start sentence', () => {
  const { container } = render(
    <TextPageScreen
      step={{ ...postIntro, key: 'video_start' }}
      busy={false}
      onContinue={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Start Video-Phase', level: 1 })).toBeInTheDocument()
  expect(paragraphs(container)).toEqual([
    'Bitte prüfen Sie, ob das Fenster auf Vollbildmodus steht, oder fragen Sie die Versuchsleitung danach.',
    'Wenn Sie bereit sind, mit der Video-Phase zu starten, drücken Sie bitte auf „Weiter“.',
  ])
})

test('the discussion phase opens with the think-aloud instruction from the mockup', () => {
  const { container } = render(
    <TextPageScreen
      step={{ ...postIntro, key: 'discussion_start' }}
      busy={false}
      onContinue={vi.fn()}
    />,
  )
  expect(
    screen.getByRole('heading', { name: 'Start Erörterungs-Phase', level: 1 }),
  ).toBeInTheDocument()
  const shown = paragraphs(container)
  expect(shown).toHaveLength(8)
  expect(shown[0]).toBe(
    'Sie werden nun gebeten, laut zu denken, während Sie sich Ihre Screenrecordings ansehen.',
  )
  expect(shown[1]).toBe(
    'Fragen Sie die Versuchsleitung, ob der Vollbildmodus deaktiviert und die Bildschirmaufnahme gestartet werden kann.',
  )
  expect(shown[2]).toMatch(/^Verbalisieren Sie dabei bitte .* Bearbeitungsprozess erinnern\.$/)
  expect(shown[3]).toBe('Wichtig ist dabei:')
  expect(shown[4]).toMatch(/^Uns interessiert nicht, .* durch den Kopf gegangen\?$/)
  expect(shown[5]).toMatch(/^Versuchen Sie, .* besonders gut formulieren\.$/)
  expect(shown[6]).toMatch(/^Verhalten Sie sich .* keine richtigen oder falschen Antworten\.$/)
  expect(shown[7]).toBe('Wenn Sie bereit sind zu starten, klicken Sie bitte auf „Weiter“.')
  // Bold where the mockup has it, and no stray emphasis marks left in the text.
  expect(
    Array.from(container.querySelectorAll('strong')).map((strong) => strong.textContent),
  ).toEqual(['Wichtig ist dabei:', '„Weiter“'])
  expect(container.textContent).not.toContain('*')
  // The earlier one-line text is replaced rather than repeated after it.
  expect(container.textContent).not.toContain('starten Sie mit der Erörterungs-Phase')
})

test.each(['video_start', 'discussion_start'] as const)(
  'the English %s page has the same paragraphs and emphasis as the German one',
  async (key) => {
    const german = de.pilot.text_pages[key].body
    const english = en.pilot.text_pages[key].body
    expect(english.split('\n\n')).toHaveLength(german.split('\n\n').length)
    expect(english.match(/\*\*/g)?.length ?? 0).toBe(german.match(/\*\*/g)?.length ?? 0)
    await act(async () => {
      await i18n.changeLanguage('en')
    })
    const { container } = render(
      <TextPageScreen step={{ ...postIntro, key }} busy={false} onContinue={vi.fn()} />,
    )
    expect(paragraphs(container)).toEqual(english.replace(/\*\*/g, '').split('\n\n'))
    expect(container.textContent).not.toMatch(/Vollbild|Versuchsleitung|Weiter/)
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
  },
)

test.each(['video_start', 'discussion_start'] as const)(
  "a study's own %s text replaces the built-in wording entirely",
  (key) => {
    const { container } = render(
      <TextPageScreen
        step={{
          ...postIntro,
          key,
          title: 'Eigener Titel',
          body: 'Eigener Text.\n\nZweiter Absatz.',
        }}
        busy={false}
        onContinue={vi.fn()}
      />,
    )
    expect(screen.getByRole('heading', { name: 'Eigener Titel', level: 1 })).toBeInTheDocument()
    expect(paragraphs(container)).toEqual(['Eigener Text.', 'Zweiter Absatz.'])
  },
)
