import { render } from '@testing-library/react'

import StudyText from './StudyText'

const TEXT = 'Schau dir den Code an.\n\n```java\nint i = 0;\n```\n\nWo liegt der Fehler?'

test('emphasizes the timed-section instruction without rendering author HTML', () => {
  const { container } = render(
    <StudyText text={'Sie haben **7 Minuten Zeit**. <img src=x onerror=alert(1)>'} />,
  )
  expect(container.querySelector('strong')).toHaveTextContent('7 Minuten Zeit')
  expect(container.querySelector('img')).toBeNull()
  expect(container.textContent).toContain('<img src=x onerror=alert(1)>')
})

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

test('a paragraph of "- " lines is a bulleted list, as an instrument prints its guidance', () => {
  const { container } = render(
    <StudyText text={'Beachten Sie:\n\n- Erstens.\n- Zweitens.\n\n- 1 = gut\n- 2 = schlecht'} />,
  )
  const children = Array.from(container.children)
  expect(children.map((c) => c.tagName)).toEqual(['P', 'UL', 'UL'])
  expect(Array.from(children[1].querySelectorAll('li')).map((li) => li.textContent)).toEqual([
    'Erstens.',
    'Zweitens.',
  ])
  expect(children[2].textContent).toBe('1 = gut2 = schlecht')
})

test('a dash inside ordinary prose does not make a list', () => {
  const { container } = render(<StudyText text={'Erst dies - dann das.\n- Und eine Zeile'} />)
  expect(container.firstElementChild?.tagName).toBe('P')
})

test('code segments in one exercise continue numbering across prose and internal blank lines', () => {
  const text = '```java\nint a;\n\nint b;\n```\n\nWeiter:\n\n```java\nreturn a + b;\n```'
  const { container } = render(<StudyText text={text} />)
  expect(
    Array.from(container.querySelectorAll('.code__line')).map((line) =>
      line.getAttribute('data-line'),
    ),
  ).toEqual(['1', '2', '3', '4'])
})

test('an explicit starting line applies to the exercise and a separate exercise starts fresh', () => {
  const text = '```java\nint a;\n```\n\n```java\nreturn a;\n```'
  const { container } = render(
    <>
      <StudyText text={text} startLine={8} />
      <StudyText text={text} />
    </>,
  )
  expect(
    Array.from(container.querySelectorAll('.code__line')).map((line) =>
      line.getAttribute('data-line'),
    ),
  ).toEqual(['8', '9', '1', '2'])
})

test('inline code stays escaped and student-task blocks can restart without changing CK defaults', () => {
  const text =
    'Klasse `Heizung` und `<img src=x>`.\n\n```java\nint a;\nint b;\n```\n\n```java\nreturn a;\n```'
  const { container, rerender } = render(<StudyText text={text} restartCodeBlocks />)
  expect(container.querySelector('p code')).toHaveTextContent('Heizung')
  expect(container.querySelector('img')).toBeNull()
  expect(
    Array.from(container.querySelectorAll('.code__line')).map((line) =>
      line.getAttribute('data-line'),
    ),
  ).toEqual(['1', '2', '1'])
  rerender(<StudyText text={text} />)
  expect(
    Array.from(container.querySelectorAll('.code__line')).map((line) =>
      line.getAttribute('data-line'),
    ),
  ).toEqual(['1', '2', '3'])
})

test('shared stimulus groups prose without moving or dropping code lines', () => {
  const source =
    'Situation.\n\n```java\nclass Example {\n\n  int value;\n}\n```\n\nBeachten Sie den Wert.'
  const { container, rerender } = render(<StudyText text={source} layout="stimulus" />)
  const stimulus = container.querySelector('.study-stimulus')!
  expect(stimulus).toHaveClass('study-stimulus--with-code')
  expect(Array.from(stimulus.children).map((child) => child.tagName)).toEqual(['DIV', 'PRE', 'DIV'])
  expect(
    Array.from(stimulus.querySelectorAll('.code__line')).map((line) => line.textContent),
  ).toEqual(['class Example {\n', '\n', '  int value;\n', '}\n'])
  expect(stimulus.firstElementChild).toHaveTextContent('Situation.')
  expect(stimulus.lastElementChild).toHaveTextContent('Beachten Sie den Wert.')
  rerender(<StudyText text="Situation ohne Code." layout="stimulus" />)
  expect(container.querySelector('.study-stimulus')).not.toHaveClass('study-stimulus--with-code')
})
