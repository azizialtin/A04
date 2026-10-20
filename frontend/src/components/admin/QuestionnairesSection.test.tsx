import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type AdminQuestionnaire } from '../../api/admin'
import { ToastProvider } from '../Toast'
import QuestionnairesSection from './QuestionnairesSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listQuestionnaires: vi.fn(),
      createQuestionnaire: vi.fn(),
      updateQuestionnaire: vi.fn(),
    },
  }
})

const listQuestionnaires = vi.mocked(adminApi.listQuestionnaires)
const updateQuestionnaire = vi.mocked(adminApi.updateQuestionnaire)

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <QuestionnairesSection studyId={9} />
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  listQuestionnaires.mockReset().mockResolvedValue([])
  updateQuestionnaire.mockReset()
})

test('the form opens with an example that the preview renders, Java code included', () => {
  view()
  const preview = screen.getByLabelText('Vorschau')
  expect(within(preview).getByRole('heading', { name: 'Titel der Seite' })).toBeInTheDocument()
  expect(within(preview).getByText('In welcher Zeile steckt der Fehler?')).toBeInTheDocument()
  const lines = preview.querySelectorAll('.code__line')
  expect(lines).toHaveLength(7)
  expect(lines[0].textContent).toBe('public int max(int[] a) {\n')
  const configured = JSON.parse(
    (screen.getByLabelText(/Fragen \(JSON/) as HTMLTextAreaElement).value,
  )
  expect(configured[0]).toMatchObject({ type: 'line_numbers', min: 1, max: 7 })
  expect(within(preview).getAllByRole('textbox')).toHaveLength(1)
  fireEvent.click(within(preview).getByRole('button', { name: /Fehler bezieht sich/ }))
  expect(within(preview).getAllByRole('spinbutton')).toHaveLength(2)
})

test('the preview follows the title, the instruction and the JSON as they are typed', () => {
  view()
  fireEvent.change(screen.getByLabelText('Titel'), { target: { value: 'MSK: Aufgabe 8' } })
  fireEvent.change(screen.getByLabelText(/Beschreibung/), {
    target: { value: 'Bitte beachten:\n\n- Erstens.\n- Zweitens.' },
  })
  const preview = screen.getByLabelText('Vorschau')
  expect(within(preview).getByRole('heading', { name: 'MSK: Aufgabe 8' })).toBeInTheDocument()
  expect(
    within(preview)
      .getAllByRole('listitem')
      .map((li) => li.textContent),
  ).toEqual(['Erstens.', 'Zweitens.'])

  fireEvent.change(screen.getByLabelText(/Fragen \(JSON/), { target: { value: '[{"id": "x",' } })
  expect(screen.queryByLabelText('Vorschau')).toBeNull()
  expect(screen.getByText('Ungültiges JSON.')).toBeInTheDocument()
})

test('a preset fills the JSON and the preview shows its shape', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Tabelle (wie MSK)' }))
  const table = within(screen.getByLabelText('Vorschau')).getByRole('table')
  expect(within(table).getAllByRole('radio')).toHaveLength(18)
  expect((screen.getByLabelText(/Fragen \(JSON/) as HTMLTextAreaElement).value).toContain(
    '"matrix": "msk_pre_8"',
  )

  fireEvent.click(screen.getByRole('button', { name: 'Skalen' }))
  expect(within(screen.getByLabelText('Vorschau')).getByRole('slider')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Auswahl & Freitext' }))
  const preview = screen.getByLabelText('Vorschau')
  // The follow-up only appears once the answer it depends on is given.
  expect(within(preview).queryByText('Seit wie vielen Jahren?')).toBeNull()
  fireEvent.click(within(preview).getByRole('radio', { name: 'Ja' }))
  expect(within(preview).getByText('Seit wie vielen Jahren?')).toBeInTheDocument()
})

const savedQuestionnaire: AdminQuestionnaire = {
  id: 42,
  study_id: 9,
  placement: 'pre_test',
  title: 'Existing debugging page',
  description: 'Original instruction',
  section: 'Debugging',
  order_index: 6,
  questions: [
    { id: 'age', type: 'number', text: 'Alter', min: 16, max: 99 },
    {
      id: 'debug_1',
      type: 'number',
      text: 'Welche Zeile?',
      code: ['int a;', 'return a;'],
      min: 7,
      max: 8,
      code_start_line: 7,
      required: false,
      custom_analysis_key: 'keep me',
    },
    { id: 'debug_1_why', type: 'free_text', text: 'Was ist der Fehler?' },
    { id: 'debug_2', type: 'number', text: 'Andere Zeile?', code: ['int b;'], min: 1, max: 1 },
  ],
}

test('an existing code question converts only after explicit selection and keeps every other field', async () => {
  listQuestionnaires.mockResolvedValue([savedQuestionnaire])
  updateQuestionnaire.mockImplementation(async (id, body) => {
    const updated = { ...savedQuestionnaire, ...body, id }
    listQuestionnaires.mockResolvedValue([updated])
    return updated
  })
  view()
  const summary = await screen.findByText('4 Fragen · Codefragen')
  fireEvent.click(summary)
  const questions = summary.closest('details')!
  expect(updateQuestionnaire).not.toHaveBeenCalled()
  expect(within(questions).queryByRole('button', { name: /: age$/ })).not.toBeInTheDocument()
  fireEvent.click(
    within(questions).getByRole('button', { name: 'Mehrere Zeilennummern erlauben: debug_1' }),
  )

  await waitFor(() => expect(updateQuestionnaire).toHaveBeenCalledTimes(1))
  expect(updateQuestionnaire).toHaveBeenCalledWith(42, {
    questions: savedQuestionnaire.questions.map((question, index) =>
      index === 1 ? { ...(question as object), type: 'line_numbers' } : question,
    ),
  })
  await waitFor(() =>
    expect(within(questions).queryByRole('button', { name: /: debug_1$/ })).not.toBeInTheDocument(),
  )
  expect(within(questions).getByText('Mehrere Zeilennummern erlaubt.')).toBeInTheDocument()
  expect(within(questions).getByRole('button', { name: /: debug_2$/ })).toBeInTheDocument()
  expect(savedQuestionnaire.questions[1]).toMatchObject({ type: 'number' })
})

test('failed conversion leaves the existing question available for retry', async () => {
  listQuestionnaires.mockResolvedValue([savedQuestionnaire])
  updateQuestionnaire.mockRejectedValue(new Error('offline'))
  view()
  const summary = await screen.findByText('4 Fragen · Codefragen')
  fireEvent.click(summary)
  const questions = summary.closest('details')!
  fireEvent.click(within(questions).getByRole('button', { name: /: debug_1$/ }))
  expect(await within(questions).findByRole('alert')).toHaveTextContent('konnte nicht umgestellt')
  expect(within(questions).getByRole('button', { name: /: debug_1$/ })).toBeEnabled()
})
