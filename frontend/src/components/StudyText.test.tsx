import { render } from '@testing-library/react'

import StudyText from './StudyText'

const TEXT = 'Schau dir den Code an.\n\n```java\nint i = 0;\n```\n\nWo liegt der Fehler?'

test('prose becomes paragraphs and the fenced code a numbered window, in order', () => {
  const { container } = render(<StudyText text={TEXT} className="lead" />)

  const children = Array.from(container.children)
  expect(children.map((c) => c.tagName)).toEqual(['P', 'PRE', 'P'])
  expect(children[0]).toHaveClass('lead')
  expect(children[0].textContent).toBe('Schau dir den Code an.')
  expect(children[1].querySelector('.code__line')?.getAttribute('data-line')).toBe('1')
  expect(children[2].textContent).toBe('Wo liegt der Fehler?')
})

test('text with no code is paragraphs split on blank lines, as before', () => {
  const { container } = render(<StudyText text={'Eins.\n\nZwei.'} />)
  expect(Array.from(container.children).map((c) => c.textContent)).toEqual(['Eins.', 'Zwei.'])
})

test('preserve mode keeps line breaks inside the prose, as the popups always have', () => {
  const { container } = render(
    <StudyText text={'Zeile 1\nZeile 2\n\n```\nint x;\n```'} mode="preserve" />,
  )
  const [prose, code] = Array.from(container.children)
  expect(prose.tagName).toBe('P')
  expect((prose as HTMLElement).style.whiteSpace).toBe('pre-wrap')
  expect(prose.textContent).toBe('Zeile 1\nZeile 2')
  expect(code.tagName).toBe('PRE')
})
