import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'

import type { Question } from '../../lib/questionnaire'
import QuestionnaireRenderer from './QuestionnaireRenderer'

const questions: Question[] = [
  { id: 'c', type: 'likert', text: 'Confidence', scale_min: 1, scale_max: 5 },
]

test('authored columns preserve question, keyboard, and submitted answer order', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const grouped: Question[] = [
    { id: 'a', type: 'free_text', text: 'Erste Antwort', layout_column: 1 },
    { id: 'b', type: 'free_text', text: 'Zweite Antwort', layout_column: 2 },
    { id: 'reason', type: 'free_text', text: 'Begründung', layout_column: 2 },
    { id: 'c', type: 'free_text', text: 'Dritte Antwort', layout_column: 3 },
  ]
  const { container, rerender } = render(
    <QuestionnaireRenderer title="PCK" questions={grouped} layout="columns" onSubmit={onSubmit} />,
  )
  const columns = container.querySelectorAll('.question-column')
  expect(columns).toHaveLength(3)
  expect(
    Array.from(columns).map((column) =>
      Array.from(column.querySelectorAll('.qfield')).map((field) => field.getAttribute('data-aoi')),
    ),
  ).toEqual([['question.a'], ['question.b', 'question.reason'], ['question.c']])
  for (const [index, input] of screen.getAllByRole('textbox').entries()) {
    await user.tab()
    expect(input).toHaveFocus()
    await user.keyboard(String(index + 1))
  }
  await user.tab()
  expect(screen.getByRole('button', { name: 'Weiter' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(onSubmit).toHaveBeenCalledWith({ a: '1', b: '2', reason: '3', c: '4' }, expect.any(Number))
  // Metadata does not change an ordinary questionnaire's layout.
  rerender(<QuestionnaireRenderer title="Legacy" questions={grouped} onSubmit={onSubmit} />)
  expect(container.querySelector('.qlist--columns')).toBeNull()
})

test('invalid column groups fall back without sorting or splitting a matrix', () => {
  const row = (id: string, column: 1 | 2): Question => ({
    id,
    type: 'multiple_choice',
    text: id,
    matrix: 'rating',
    options: ['1', '2'],
    layout_column: column,
  })
  const { container, rerender } = render(
    <QuestionnaireRenderer
      title="PCK"
      questions={[row('first', 1), row('second', 2)]}
      layout="columns"
      onSubmit={vi.fn()}
    />,
  )
  expect(screen.getAllByRole('table')).toHaveLength(1)
  expect(container.querySelector('.qlist--columns')).toBeNull()
  rerender(
    <QuestionnaireRenderer
      title="PCK"
      questions={[
        { id: 'first', type: 'free_text', text: 'First', layout_column: 2 },
        { id: 'second', type: 'free_text', text: 'Second', layout_column: 1 },
      ]}
      layout="columns"
      onSubmit={vi.fn()}
    />,
  )
  expect(container.querySelector('.qlist--columns')).toBeNull()
  expect(
    Array.from(container.querySelectorAll('.qfield')).map((field) =>
      field.getAttribute('data-aoi'),
    ),
  ).toEqual(['question.first', 'question.second'])
})

test('wide tasks omit only a complete duplicate numbered legend, preserving prompt and accessible choices', () => {
  const prompt = 'Bewerten Sie die Aussage (1 = sehr plausibel, 2 = nicht plausibel).'
  const row: Question = {
    id: 'rating',
    type: 'multiple_choice',
    text: 'Die Aussage.',
    matrix: 'plausibility',
    matrix_prompt: prompt,
    layout_column: 1,
    options: [
      { value: 1, label: 'sehr plausibel' },
      { value: 2, label: 'nicht plausibel' },
    ],
  }
  const { container, rerender } = render(
    <QuestionnaireRenderer title="PCK" questions={[row]} layout="columns" onSubmit={vi.fn()} />,
  )
  expect(screen.getByText(prompt)).toBeVisible()
  expect(container.querySelector('.matrix__legend')).toBeNull()
  expect(screen.getByRole('radio', { name: 'Die Aussage.: 1 – sehr plausibel' })).toBeVisible()
  expect(screen.getByRole('radio', { name: 'Die Aussage.: 2 – nicht plausibel' })).toBeVisible()
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
    '',
    '1',
    '2',
  ])

  // A partial, differently numbered, or longer label cannot replace the legend.
  for (const matrix_prompt of [
    'Bewerten Sie die Aussage (1 = sehr plausibel).',
    'Bewerten Sie die Aussage (2 = sehr plausibel, 1 = nicht plausibel).',
    'Bewerten Sie die Aussage (1 = sehr plausibel oder sicher, 2 = nicht plausibel).',
  ]) {
    rerender(
      <QuestionnaireRenderer
        title="PCK"
        questions={[{ ...row, matrix_prompt }]}
        layout="columns"
        onSubmit={vi.fn()}
      />,
    )
    expect(container.querySelector('.matrix__legend')).toBeVisible()
    expect(screen.getByText(matrix_prompt)).toBeVisible()
  }
  // Ordinary questionnaires keep their existing legend even with the same prompt.
  rerender(<QuestionnaireRenderer title="Legacy" questions={[row]} onSubmit={vi.fn()} />)
  expect(container.querySelector('.matrix__legend')).toBeVisible()
})

test('blocks submit until the required question is answered', () => {
  const onSubmit = vi.fn()
  render(<QuestionnaireRenderer title="Intro" questions={questions} onSubmit={onSubmit} />)

  const submit = screen.getByRole('button')
  expect(submit).toBeDisabled()

  fireEvent.click(screen.getByRole('radio', { name: '3' }))
  expect(submit).toBeEnabled()

  fireEvent.click(submit)
  expect(onSubmit).toHaveBeenCalledWith({ c: 3 }, expect.any(Number))
})

test('integrated scale headers preserve full labels and saved values without changing the default legend', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  const row: Question = {
    id: 'suitability',
    type: 'multiple_choice',
    text: 'Eine Handlungsmöglichkeit.',
    matrix: 'suitability',
    options: [
      { value: 10, label: 'sehr geeignete Handlungsmöglichkeit für diese Situation' },
      { value: 20, label: 'sehr ungeeignete Handlungsmöglichkeit für diese Situation' },
    ],
  }
  const { container, rerender } = render(
    <QuestionnaireRenderer
      title="MESP"
      questions={[row]}
      matrixLabels="headers"
      onSubmit={onSubmit}
    />,
  )
  expect(screen.getByRole('table', { name: 'Antwortmöglichkeiten' })).toBeVisible()
  expect(container.querySelector('.matrix__legend')).toBeNull()
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
    '',
    '1sehr geeignete Handlungsmöglichkeit für diese Situation',
    '2sehr ungeeignete Handlungsmöglichkeit für diese Situation',
  ])
  expect(container.querySelectorAll('th[data-aoi="matrix.suitability.legend"]')).toHaveLength(2)
  await user.click(
    screen.getByRole('radio', {
      name: 'Eine Handlungsmöglichkeit.: 2 – sehr ungeeignete Handlungsmöglichkeit für diese Situation',
    }),
  )
  await user.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(onSubmit).toHaveBeenCalledWith({ suitability: 20 }, expect.any(Number))
  rerender(<QuestionnaireRenderer title="Legacy" questions={[row]} onSubmit={onSubmit} />)
  expect(container.querySelector('.matrix__legend')).toBeVisible()
  expect(container.querySelector('.matrix__scale-label')).toBeNull()
})

const multiSelect: Question = {
  id: 'multi',
  type: 'multi_select',
  text: 'Welche Maßnahmen?',
  options: [
    { value: 1, label: 'Werte verfolgen' },
    { value: '1', label: 'Ergebnis vergleichen' },
  ],
}

test('checkboxes support keyboard selection and preserve numeric versus text option values', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  render(<QuestionnaireRenderer title="PCK" questions={[multiSelect]} onSubmit={onSubmit} />)
  const submit = screen.getByRole('button', { name: 'Weiter' })
  expect(submit).toBeDisabled()
  expect(screen.getByRole('group', { name: /Welche Maßnahmen/ })).toBeInTheDocument()
  const first = screen.getByRole('checkbox', { name: 'Werte verfolgen' })
  expect(first).toHaveAccessibleDescription('Mehrere Antworten sind möglich.')
  await user.tab()
  expect(first).toHaveFocus()
  await user.keyboard(' ')
  await user.click(screen.getByRole('checkbox', { name: 'Ergebnis vergleichen' }))
  expect(first).toBeChecked()
  await user.click(submit)
  expect(onSubmit).toHaveBeenCalledWith({ multi: [1, '1'] }, expect.any(Number))
  await user.click(first)
  expect(screen.getByRole('checkbox', { name: 'Ergebnis vergleichen' })).toBeChecked()
  await user.click(screen.getByRole('checkbox', { name: 'Ergebnis vergleichen' }))
  expect(submit).toBeDisabled()
})

test('saved checkbox selections restore and an optional question can submit an empty array', async () => {
  const user = userEvent.setup()
  const onSubmit = vi.fn()
  render(
    <QuestionnaireRenderer
      title="PCK"
      questions={[{ ...multiSelect, required: false }]}
      initialAnswers={{ multi: [1, '1'] }}
      onSubmit={onSubmit}
    />,
  )
  for (const checkbox of screen.getAllByRole('checkbox')) {
    expect(checkbox).toBeChecked()
    await user.click(checkbox)
  }
  await user.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(onSubmit).toHaveBeenCalledWith({ multi: [] }, expect.any(Number))
})

test('reports how long the questionnaire took', () => {
  vi.useFakeTimers()
  const onSubmit = vi.fn()
  render(<QuestionnaireRenderer title="Intro" questions={questions} onSubmit={onSubmit} />)

  fireEvent.click(screen.getByRole('radio', { name: '3' }))
  vi.advanceTimersByTime(17_000)
  fireEvent.click(screen.getByRole('button'))

  expect(onSubmit).toHaveBeenCalledWith({ c: 3 }, 17)
  vi.useRealTimers()
})

test('a slider has no answer until it is touched', () => {
  const onSubmit = vi.fn()
  const vas: Question[] = [
    {
      id: 'td_demand',
      type: 'slider',
      text: 'Wie viel Anstrengung?',
      min: 0,
      max: 9,
      labels: { min: 'sehr, sehr wenig', max: 'sehr, sehr viel' },
    },
  ]
  render(<QuestionnaireRenderer title="Nach dem Fall" questions={vas} onSubmit={onSubmit} />)

  // The anchors are the scale; without them the numbers mean nothing.
  expect(screen.getByText('sehr, sehr wenig')).toBeInTheDocument()
  expect(screen.getByText('sehr, sehr viel')).toBeInTheDocument()

  // Untouched it reads blank and blocks submit, rather than recording a 0
  // nobody chose.
  expect(screen.getByText('—')).toBeInTheDocument()
  expect(screen.getByRole('button')).toBeDisabled()

  fireEvent.change(screen.getByRole('slider'), { target: { value: '7' } })
  fireEvent.click(screen.getByRole('button'))
  expect(onSubmit).toHaveBeenCalledWith({ td_demand: 7 }, expect.any(Number))
})

test('releasing the slider where it already rests still counts as an answer', () => {
  const onSubmit = vi.fn()
  const vas: Question[] = [
    { id: 'confidence', type: 'slider', text: 'Wie sicher?', min: 1, max: 5 },
  ]
  render(<QuestionnaireRenderer title="Diagnose" questions={vas} onSubmit={onSubmit} />)

  // No change event fires in that case, so the pointer release has to commit it.
  fireEvent.pointerUp(screen.getByRole('slider'))
  fireEvent.click(screen.getByRole('button'))
  expect(onSubmit).toHaveBeenCalledWith({ confidence: 3 }, expect.any(Number))
})

test('a question gated on another one is neither shown nor required', () => {
  const onSubmit = vi.fn()
  const gated: Question[] = [
    {
      id: 'java_ex',
      type: 'multiple_choice',
      text: 'Erfahrung mit Java?',
      options: [
        { value: 1, label: 'ja' },
        { value: 0, label: 'nein' },
      ],
    },
    {
      id: 'java_years',
      type: 'number',
      text: 'Wie viele Jahre?',
      show_if: { question: 'java_ex', equals: 1 },
    },
  ]
  render(<QuestionnaireRenderer title="Vorwissen" questions={gated} onSubmit={onSubmit} />)

  fireEvent.click(screen.getByRole('radio', { name: 'nein' }))
  expect(screen.queryByText('Wie viele Jahre?')).not.toBeInTheDocument()
  expect(screen.getByRole('button')).toBeEnabled()

  fireEvent.click(screen.getByRole('radio', { name: 'ja' }))
  expect(screen.getByText(/Wie viele Jahre\?/)).toBeInTheDocument()
  expect(screen.getByRole('button')).toBeDisabled()
})

test('tabbing onto an untouched slider does not answer it', () => {
  const onSubmit = vi.fn()
  const vas: Question[] = [
    { id: 'td_demand', type: 'slider', text: 'Wie viel Anstrengung?', min: 0, max: 9 },
  ]
  render(<QuestionnaireRenderer title="Nach dem Fall" questions={vas} onSubmit={onSubmit} />)

  // The keyup of the Tab that moved focus here lands on this input. Reading the
  // handle's resting position then would record a 5 nobody chose.
  fireEvent.keyUp(screen.getByRole('slider'), { key: 'Tab' })

  expect(screen.getByText('—')).toBeInTheDocument()
  expect(screen.getByRole('button')).toBeDisabled()
})

test('questions that share a matrix key are one table with the statements listed once', () => {
  const onSubmit = vi.fn()
  const ladder = [
    { value: 'A0', label: 'Dieses Konzept ist mir nicht bekannt.' },
    { value: 'A1', label: 'Im Allgemeinen weiß ich, was dieses Konzept bedeutet.' },
  ]
  const rows: Question[] = [
    {
      id: 'ck_pre_vars',
      type: 'multiple_choice',
      text: 'Variablen',
      options: ladder,
      matrix: 'ck',
    },
    {
      id: 'ck_pre_loop',
      type: 'multiple_choice',
      text: 'Schleifen',
      options: ladder,
      matrix: 'ck',
    },
  ]
  render(<QuestionnaireRenderer title="Fachwissen" questions={rows} onSubmit={onSubmit} />)

  // The statements appear once, in the legend, not under every row.
  expect(screen.getAllByText('Dieses Konzept ist mir nicht bekannt.')).toHaveLength(1)
  expect(screen.getByRole('table')).toBeInTheDocument()
  expect(screen.getAllByRole('row')).toHaveLength(3) // header + two concepts

  // One choice per row, each row required on its own.
  fireEvent.click(screen.getByRole('radio', { name: /^Variablen: 2/ }))
  expect(screen.getByRole('button')).toBeDisabled()
  fireEvent.click(screen.getByRole('radio', { name: /^Schleifen: 1/ }))
  expect(screen.getByRole('button')).toBeEnabled()

  fireEvent.click(screen.getByRole('button'))
  // Stored under the rows' own variable names, with the data dictionary's values.
  expect(onSubmit).toHaveBeenCalledWith(
    { ck_pre_vars: 'A1', ck_pre_loop: 'A0' },
    expect.any(Number),
  )
})

test('a question can show code above its answer field, numbered line by line', () => {
  const debugging: Question[] = [
    {
      id: 'debug_exe_1',
      type: 'number',
      text: 'In welcher Zeile steckt der Fehler?',
      code: ['int i = 0;', 'while (i <= n) {', '  sum += a[i];', '}'],
      min: 1,
      max: 4,
    },
  ]
  const onSubmit = vi.fn()
  render(<QuestionnaireRenderer title="Debugging" questions={debugging} onSubmit={onSubmit} />)

  const lines = document.querySelectorAll('.code__line')
  expect(lines).toHaveLength(4)
  expect(lines[1].getAttribute('data-line')).toBe('2')
  // The numbers are drawn by the stylesheet; the text is the code alone.
  expect(document.querySelector('.code')?.textContent).toBe(
    'int i = 0;\nwhile (i <= n) {\n  sum += a[i];\n}\n',
  )
  // The code sits between the question and its field, and the field still works.
  const field = screen.getByRole('spinbutton')
  expect(document.querySelector('.code')?.compareDocumentPosition(field)).toBe(
    Node.DOCUMENT_POSITION_FOLLOWING,
  )
  fireEvent.change(field, { target: { value: '2' } })
  fireEvent.click(screen.getByRole('button'))
  expect(onSubmit).toHaveBeenCalledWith({ debug_exe_1: 2 }, expect.any(Number))
})

const multiLine: Question[] = [
  { id: 'lines', type: 'line_numbers', text: 'Welche Zeilen?', min: 1, max: 20 },
  { id: 'reason', type: 'free_text', text: 'Was ist der Fehler?' },
]

test('a capped CK task reuses line controls and preserves both answer components', () => {
  const onSubmit = vi.fn()
  const onAnswersChange = vi.fn()
  render(
    <QuestionnaireRenderer
      title="CK"
      questions={[
        { id: 'ck', type: 'debugging', text: 'Welche Zeilen?', min: 1, max: 29, max_entries: 5 },
      ]}
      onSubmit={onSubmit}
      onAnswersChange={onAnswersChange}
    />,
  )
  const submit = screen.getByRole('button', { name: 'Weiter' })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } })
  expect(submit).toBeDisabled()
  fireEvent.change(screen.getByRole('textbox', { name: 'Was ist der Fehler?' }), {
    target: { value: 'Indexfehler' },
  })
  for (let line = 2; line <= 5; line++) {
    fireEvent.click(screen.getByRole('button', { name: /Fehler bezieht sich/ }))
    fireEvent.change(
      screen.getByRole('spinbutton', { name: `Welche Zeilen?: Zeilennummer ${line}` }),
      { target: { value: String(line) } },
    )
  }
  expect(screen.getByRole('button', { name: /Fehler bezieht sich/ })).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: /Fehler bezieht sich/ }))
  expect(screen.getAllByRole('spinbutton')).toHaveLength(5)
  expect(onAnswersChange).toHaveBeenLastCalledWith({
    ck: { lines: [1, 2, 3, 4, 5], explanation: 'Indexfehler' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Zeilennummer 3 entfernen' }))
  expect(screen.getByRole('button', { name: /Fehler bezieht sich/ })).toBeEnabled()
  fireEvent.click(submit)
  expect(onSubmit).toHaveBeenCalledWith(
    { ck: { lines: [1, 2, 4, 5], explanation: 'Indexfehler' } },
    expect.any(Number),
  )
})

test('a partial debugging answer restores without silently filling missing components', () => {
  render(
    <QuestionnaireRenderer
      title="CK"
      questions={[{ id: 'ck', type: 'debugging', text: 'Fehler?' }]}
      initialAnswers={{ ck: { lines: [2, null], explanation: 'Unfertig' } }}
      onSubmit={vi.fn()}
    />,
  )
  expect(screen.getAllByRole('spinbutton')[0]).toHaveValue(2)
  expect(screen.getAllByRole('spinbutton')[1]).toHaveValue(null)
  expect(screen.getByRole('textbox')).toHaveValue('Unfertig')
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
})

test('ranking needs an explicit choice, supports keyboard buttons and restores chosen order', () => {
  const ranking: Question = {
    id: 'order',
    type: 'ranking',
    text: 'Reihenfolge',
    options: [
      { value: 'a', label: 'Prüfen' },
      { value: 'b', label: 'Testen' },
      { value: 'c', label: 'Korrigieren' },
    ],
  }
  const onSubmit = vi.fn()
  const { unmount } = render(
    <QuestionnaireRenderer title="PCK" questions={[ranking]} onSubmit={onSubmit} />,
  )
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  const move = screen.getByRole('button', { name: 'Testen: Nach oben verschieben' })
  move.focus()
  expect(move).toHaveFocus()
  fireEvent.click(move)
  expect(
    screen
      .getAllByRole('listitem')
      .map((item) => within(item).getByText(/Prüfen|Testen|Korrigieren/).textContent),
  ).toEqual(['Testen', 'Prüfen', 'Korrigieren'])
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(onSubmit).toHaveBeenCalledWith({ order: ['b', 'a', 'c'] }, expect.any(Number))
  unmount()
  render(
    <QuestionnaireRenderer
      title="PCK"
      questions={[ranking]}
      initialAnswers={{ order: ['c', 'a', 'b'] }}
      onSubmit={onSubmit}
    />,
  )
  expect(screen.getAllByRole('listitem')[0]).toHaveTextContent('Korrigieren')
  expect(
    screen.queryByRole('button', { name: 'Diese Reihenfolge übernehmen' }),
  ).not.toBeInTheDocument()
})

test('the displayed ranking can be explicitly confirmed without moving a step', () => {
  const onSubmit = vi.fn()
  render(
    <QuestionnaireRenderer
      title="PCK"
      questions={[{ id: 'order', type: 'ranking', text: 'Ordnen', options: ['a', 'b'] }]}
      onSubmit={onSubmit}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Diese Reihenfolge übernehmen' }))
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(onSubmit).toHaveBeenCalledWith({ order: ['a', 'b'] }, expect.any(Number))
})

test('new code blocks preserve blank first lines and continue across named files', () => {
  const { container } = render(
    <QuestionnaireRenderer
      title="CK"
      questions={[
        {
          id: 'ck',
          type: 'debugging',
          text: 'Fehler?',
          code_blocks: [
            { filename: 'Erste.java', code: ['', 'class Erste {', '}'], start_line: 1 },
            { filename: 'Zweite.java', code: ['class Zweite {', '}'] },
          ],
        },
      ]}
      onSubmit={vi.fn()}
    />,
  )
  expect(screen.getByText('Erste.java')).toBeInTheDocument()
  expect(screen.getByText('Zweite.java')).toBeInTheDocument()
  const lines = container.querySelectorAll('.code__line')
  expect(Array.from(lines, (line) => line.getAttribute('data-line'))).toEqual([
    '1',
    '2',
    '3',
    '4',
    '5',
  ])
  expect(lines[0]).toHaveTextContent('')
  expect(lines[1]).toHaveTextContent('class Erste')
})

test('one error may reference more than five lines while keeping a single explanation', () => {
  const onSubmit = vi.fn()
  render(<QuestionnaireRenderer title="Debugging" questions={multiLine} onSubmit={onSubmit} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Indexfehler' } })
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '1' } })
  for (let line = 2; line <= 7; line++) {
    fireEvent.click(screen.getByRole('button', { name: /Fehler bezieht sich/ }))
    const input = screen.getByRole('spinbutton', { name: `Welche Zeilen?: Zeilennummer ${line}` })
    expect(input).toHaveFocus()
    fireEvent.change(input, { target: { value: String(line) } })
  }
  expect(screen.getAllByRole('spinbutton')).toHaveLength(7)
  expect(screen.getAllByRole('textbox')).toHaveLength(1)
  fireEvent.click(screen.getByRole('button', { name: /Zeilennummer 2 entfernen/ }))
  expect(screen.getByRole('spinbutton', { name: /Zeilennummer 2$/ })).toHaveFocus()
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(onSubmit).toHaveBeenCalledWith(
    { lines: [1, 3, 4, 5, 6, 7], reason: 'Indexfehler' },
    expect.any(Number),
  )
})

test('line references enforce whole numbers and configured bounds, including added blank rows', () => {
  render(<QuestionnaireRenderer title="Debugging" questions={[multiLine[0]]} onSubmit={vi.fn()} />)
  const submit = screen.getByRole('button', { name: 'Weiter' })
  const input = screen.getByRole('spinbutton')
  expect(submit).toBeDisabled()
  for (const value of ['0', '1.5', '21']) {
    fireEvent.change(input, { target: { value } })
    expect(submit).toBeDisabled()
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText(/ganze Zahl zwischen 1 und 20/)).toBeInTheDocument()
  }
  fireEvent.change(input, { target: { value: '4' } })
  expect(submit).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: /Fehler bezieht sich/ }))
  expect(submit).toBeDisabled()
  fireEvent.click(screen.getByRole('button', { name: 'Zeilennummer 2 entfernen' }))
  expect(submit).toBeEnabled()
})

test('a legacy scalar line answer restores and becomes an array when another line is added', () => {
  const onSubmit = vi.fn()
  render(
    <QuestionnaireRenderer
      title="Debugging"
      questions={[multiLine[0]]}
      initialAnswers={{ lines: 4 }}
      onSubmit={onSubmit}
    />,
  )
  expect(screen.getByRole('spinbutton')).toHaveValue(4)
  fireEvent.click(screen.getByRole('button', { name: /Fehler bezieht sich/ }))
  fireEvent.change(screen.getByRole('spinbutton', { name: /Zeilennummer 2$/ }), {
    target: { value: '5' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  expect(onSubmit).toHaveBeenCalledWith({ lines: [4, 5] }, expect.any(Number))
})

test('separate question snippets continue from an explicit starting line', () => {
  const { container } = render(
    <QuestionnaireRenderer
      title="Code"
      questions={[
        { id: 'a', type: 'number', text: 'A', code: ['int a;'], code_start_line: 9 },
        { id: 'b', type: 'number', text: 'B', code: ['int b;'] },
      ]}
      onSubmit={vi.fn()}
    />,
  )
  expect(
    Array.from(container.querySelectorAll('.code__line')).map((l) => l.getAttribute('data-line')),
  ).toEqual(['9', '10'])
})

test('description, instructions and separate question snippets share one line sequence', () => {
  const { container } = render(
    <QuestionnaireRenderer
      title="Code"
      description={'```java\n\nint a;\nint b;\n\n```'}
      instruction={'Fortsetzung:\n```java\nint c;\n```'}
      questions={[
        { id: 'empty', type: 'free_text', text: 'Leer', code: [' ', ''], code_start_line: 90 },
        { id: 'a', type: 'free_text', text: 'A', code: ['int d;\n\nint e;'] },
        { id: 'reason', type: 'free_text', text: 'Begründung' },
        { id: 'b', type: 'free_text', text: 'B', code: 'int f;' },
      ]}
      onSubmit={vi.fn()}
    />,
  )
  const numbering = () =>
    Array.from(container.querySelectorAll('.code__line')).map((line) =>
      line.getAttribute('data-line'),
    )
  expect(numbering()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
  fireEvent.change(within(screen.getByRole('group', { name: 'A *' })).getByRole('textbox'), {
    target: { value: 'Ein Test' },
  })
  expect(numbering()).toEqual(['1', '2', '3', '4', '5', '6', '7'])
})

test('conditional code reserves its lines so showing it does not renumber later answers', () => {
  const { container } = render(
    <QuestionnaireRenderer
      title="Code"
      questions={[
        { id: 'show', type: 'multiple_choice', text: 'Zusatzcode?', options: ['Ja', 'Nein'] },
        {
          id: 'extra',
          type: 'free_text',
          text: 'Zusatz',
          code: ['int a;', 'int b;'],
          show_if: { question: 'show', equals: 'Ja' },
        },
        { id: 'lines', type: 'line_numbers', text: 'Fehler', code: ['int c;'], min: 3, max: 3 },
      ]}
      initialAnswers={{ lines: [3] }}
      onSubmit={vi.fn()}
    />,
  )
  const later = () => container.querySelector('[data-aoi="question.lines.code"] .code__line')
  expect(later()).toHaveAttribute('data-line', '3')
  fireEvent.click(screen.getByRole('radio', { name: 'Ja' }))
  expect(container.querySelectorAll('.code__line')).toHaveLength(3)
  expect(later()).toHaveAttribute('data-line', '3')
  fireEvent.click(screen.getByRole('radio', { name: 'Nein' }))
  expect(container.querySelectorAll('.code__line')).toHaveLength(1)
  expect(later()).toHaveAttribute('data-line', '3')
  expect(screen.getByRole('spinbutton')).toHaveValue(3)
})

test('continued line references restore and submit the displayed numbers with authored bounds', () => {
  const onSubmit = vi.fn()
  const snippets: Question[] = [
    { id: 'a', type: 'free_text', text: 'A', required: false, code: ['int a;', 'int b;'] },
    { id: 'b', type: 'line_numbers', text: 'B', code: ['int c;', 'int d;'], min: 3, max: 4 },
  ]
  render(
    <QuestionnaireRenderer
      title="Code"
      questions={snippets}
      initialAnswers={{ b: [3] }}
      onSubmit={onSubmit}
    />,
  )
  const input = screen.getByRole('spinbutton')
  const submit = screen.getByRole('button', { name: 'Weiter' })
  expect(input).toHaveValue(3)
  expect(input).toHaveAttribute('min', '3')
  expect(input).toHaveAttribute('max', '4')
  fireEvent.change(input, { target: { value: '4' } })
  fireEvent.click(submit)
  expect(onSubmit).toHaveBeenCalledWith({ b: [4] }, expect.any(Number))
  fireEvent.change(input, { target: { value: '5' } })
  expect(submit).toBeDisabled()
  expect(snippets[1].code_start_line).toBeUndefined()
  expect(snippets[1]).toMatchObject({ min: 3, max: 4 })
})

test('numeric bounds block Continue for required and optional questions', () => {
  const onSubmit = vi.fn()
  const question: Question = { id: 'number', type: 'number', text: 'Range', min: 1, max: 5 }
  const { rerender } = render(
    <QuestionnaireRenderer title="Range" questions={[question]} onSubmit={onSubmit} />,
  )
  const field = screen.getByRole('spinbutton')
  const submit = screen.getByRole('button', { name: 'Weiter' })
  for (const invalid of ['0', '999']) {
    fireEvent.change(field, { target: { value: invalid } })
    expect(submit).toBeDisabled()
    fireEvent.click(submit)
    expect(onSubmit).not.toHaveBeenCalled()
  }
  rerender(
    <QuestionnaireRenderer
      title="Range"
      questions={[{ ...question, required: false }]}
      onSubmit={onSubmit}
    />,
  )
  expect(submit).toBeDisabled()
  for (const valid of ['1', '2.5', '5']) {
    fireEvent.change(field, { target: { value: valid } })
    expect(submit).toBeEnabled()
    fireEvent.click(submit)
    expect(onSubmit).toHaveBeenLastCalledWith({ number: Number(valid) }, expect.any(Number))
  }
  fireEvent.change(field, { target: { value: '' } })
  expect(submit).toBeEnabled()
})

test('pick-two caps selection, requires two plus justification and allows changing the pair', () => {
  const onSubmit = vi.fn()
  render(
    <QuestionnaireRenderer
      title="PCK"
      onSubmit={onSubmit}
      questions={[
        {
          id: 'pair',
          type: 'multi_select',
          text: 'Wählen Sie Maßnahmen',
          options: ['A', 'B', 'C', 'D'],
          min_selections: 2,
          max_selections: 2,
        },
        { id: 'why', type: 'free_text', text: 'Begründen Sie Ihre Auswahl' },
      ]}
    />,
  )
  const next = screen.getByRole('button', { name: 'Weiter' })
  const boxes = screen.getAllByRole('checkbox')
  expect(boxes[0]).toHaveAccessibleDescription('Wählen Sie genau 2 Antworten.')
  fireEvent.click(boxes[0])
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Begründung' } })
  expect(next).toBeDisabled()
  fireEvent.click(boxes[1])
  expect(boxes[2]).toBeDisabled()
  expect(next).toBeEnabled()
  fireEvent.click(boxes[0])
  expect(boxes[2]).toBeEnabled()
  fireEvent.click(boxes[2])
  fireEvent.click(next)
  expect(onSubmit).toHaveBeenCalledWith({ pair: ['B', 'C'], why: 'Begründung' }, expect.any(Number))
})

test('matrix shows its authored prompt once and omits duplicated numeric-only legends', () => {
  const options = [1, 2, 3, 4, 5].map((value) => ({ value, label: String(value) }))
  render(
    <QuestionnaireRenderer
      title="PCK"
      onSubmit={vi.fn()}
      questions={[
        {
          id: 'a',
          type: 'multiple_choice',
          matrix: 'rating',
          matrix_prompt: '1 = sehr geeignet, 5 = überhaupt nicht geeignet',
          text: 'Maßnahme A',
          options,
        },
        { id: 'b', type: 'multiple_choice', matrix: 'rating', text: 'Maßnahme B', options },
      ]}
    />,
  )
  expect(screen.getAllByText('1 = sehr geeignet, 5 = überhaupt nicht geeignet')).toHaveLength(1)
  expect(screen.queryByText('Antwortmöglichkeiten')).toBeNull()
  expect(screen.getAllByRole('radio')).toHaveLength(10)
})

test('editing one ordinary debugging field preserves the omission of the untouched field', () => {
  const changed = vi.fn()
  const questions: Question[] = [{ id: 'ck', type: 'debugging', text: 'Fehler?', min: 1, max: 12 }]
  const { rerender } = render(
    <QuestionnaireRenderer
      key="lines"
      title="CK"
      questions={questions}
      onSubmit={vi.fn()}
      onAnswersChange={changed}
    />,
  )
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  expect(changed).toHaveBeenLastCalledWith({ ck: { lines: [3] } })
  expect(changed.mock.lastCall?.[0].ck).not.toHaveProperty('explanation')
  rerender(
    <QuestionnaireRenderer
      key="explanation"
      title="CK"
      questions={questions}
      onSubmit={vi.fn()}
      onAnswersChange={changed}
    />,
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Partial explanation' } })
  expect(changed).toHaveBeenLastCalledWith({ ck: { explanation: 'Partial explanation' } })
  expect(changed.mock.lastCall?.[0].ck).not.toHaveProperty('lines')
})

test('editing a skipped debugging answer clears its marker and sentinel for either field', () => {
  const changed = vi.fn()
  const questions: Question[] = [
    { id: 'ck', type: 'debugging', text: 'Fehler?', min: 1, max: 12, allow_skip: true },
  ]
  const skipped = { ck: { lines: [0], explanation: '', skipped: true } }
  const { rerender } = render(
    <QuestionnaireRenderer
      key="lines"
      title="CK"
      questions={questions}
      initialAnswers={skipped}
      onSubmit={vi.fn()}
      onAnswersChange={changed}
    />,
  )
  expect(screen.getByRole('spinbutton')).toHaveValue(null)
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  expect(changed).toHaveBeenLastCalledWith({ ck: { lines: [3], explanation: '' } })
  rerender(
    <QuestionnaireRenderer
      key="explanation"
      title="CK"
      questions={questions}
      initialAnswers={skipped}
      onSubmit={vi.fn()}
      onAnswersChange={changed}
    />,
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Now found it' } })
  expect(changed).toHaveBeenLastCalledWith({ ck: { lines: [], explanation: 'Now found it' } })
  expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
})
