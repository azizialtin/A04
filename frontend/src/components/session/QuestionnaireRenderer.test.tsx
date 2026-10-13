import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import type { Question } from '../../lib/questionnaire'
import QuestionnaireRenderer from './QuestionnaireRenderer'

const questions: Question[] = [
  { id: 'c', type: 'likert', text: 'Confidence', scale_min: 1, scale_max: 5 },
]

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
