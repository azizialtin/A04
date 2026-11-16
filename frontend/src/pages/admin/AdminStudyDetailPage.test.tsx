import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type Study } from '../../api/admin'
import de from '../../i18n/locales/de.json'
import AdminStudyDetailPage from './AdminStudyDetailPage'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return { ...actual, adminApi: { ...actual.adminApi, getStudy: vi.fn(), updateStudy: vi.fn() } }
})

const getStudy = vi.mocked(adminApi.getStudy)
const updateStudy = vi.mocked(adminApi.updateStudy)
const initial: Study = {
  id: 7,
  name: 'Pilot study',
  description: '',
  sosci_pretest_url: '',
  sosci_posttest_url: '',
  sosci_id_param: 'id',
  is_active: true,
  flow_version: 'pilot_20261116',
  think_aloud_mode: 'bundled',
  think_aloud_count: 3,
  think_aloud_batch_size: 1,
  video_defaults: { time_limit_seconds: null, task_description: '', info_text: '' },
  texts: {
    welcome_title: '',
    welcome_intro: '',
    welcome_steps: [],
    welcome_note: '',
    case_intro_title: '',
    case_intro_body: '',
    case_outro_title: '',
    case_outro_body: '',
    think_aloud_title: '',
    think_aloud_body: '',
  },
}

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={['/admin/studies/7?tab=details']}>
        <Routes>
          <Route path="/admin/studies/:studyId" element={<AdminStudyDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getStudy.mockReset().mockResolvedValue(initial)
  updateStudy.mockReset().mockImplementation(async (_id, values) => {
    const next = { ...initial, ...values }
    getStudy.mockResolvedValue(next)
    return next
  })
})

test('all six pilot text pages can be saved and restored without obsolete intro controls', async () => {
  const mounted = view()
  await screen.findByRole('heading', { name: 'Texte für Teilnehmer' })
  expect(screen.queryByLabelText(/Der Ablauf/)).not.toBeInTheDocument()
  expect(screen.queryByLabelText('Überschrift für das Vortest-Video')).not.toBeInTheDocument()
  const expected: Record<string, string> = {}
  for (const [key, text] of Object.entries(de.pilot.text_pages)) {
    const label = key === 'post_intro' ? 'Vor dem Abschlussfragebogen' : text.title
    const title = screen.getByLabelText(`Überschrift: ${label}`)
    const body = screen.getByLabelText(`Text: ${label}`)
    expect(body).toHaveAttribute('placeholder', text.body)
    expected[`${key}_title`] = `Titel ${key}`
    expected[`${key}_body`] = `Text ${key}\n\nZweiter Absatz.`
    fireEvent.change(title, { target: { value: expected[`${key}_title`] } })
    fireEvent.change(body, { target: { value: expected[`${key}_body`] } })
  }
  const form = screen
    .getByRole('heading', { name: 'Texte für Teilnehmer' })
    .closest('.card') as HTMLElement
  fireEvent.click(within(form).getByRole('button', { name: /^Speichern$/ }))
  await waitFor(() =>
    expect(updateStudy).toHaveBeenCalledWith(7, { texts: { ...initial.texts, ...expected } }),
  )
  mounted.unmount()
  view()
  await screen.findByRole('heading', { name: 'Texte für Teilnehmer' })
  for (const [key, text] of Object.entries(de.pilot.text_pages)) {
    const label = key === 'post_intro' ? 'Vor dem Abschlussfragebogen' : text.title
    expect(screen.getByLabelText(`Überschrift: ${label}`)).toHaveValue(expected[`${key}_title`])
    expect(screen.getByLabelText(`Text: ${label}`)).toHaveValue(expected[`${key}_body`])
  }
})

test('legacy text controls stay available without introducing new flow pages', async () => {
  getStudy.mockResolvedValue({ ...initial, flow_version: 'legacy', think_aloud_mode: 'block' })
  view()
  await screen.findByRole('heading', { name: 'Texte für Teilnehmer' })
  expect(screen.getByLabelText(/Der Ablauf/)).toBeInTheDocument()
  expect(screen.getByLabelText('Überschrift für das Vortest-Video')).toBeInTheDocument()
  expect(screen.queryByLabelText('Text: Ende Video-Phase')).not.toBeInTheDocument()
})

test('clearing the final introduction title restores its heading-free default', async () => {
  getStudy.mockResolvedValue({
    ...initial,
    texts: { ...initial.texts, post_intro_title: 'Eigener Titel' },
  })
  const mounted = view()
  const title = await screen.findByLabelText('Überschrift: Vor dem Abschlussfragebogen')
  expect(title).toHaveValue('Eigener Titel')
  expect(title).toHaveAttribute('placeholder', 'Keine Überschrift (Standard)')
  expect(
    screen.getByText(/Standardmäßig erscheint diese Seite ohne Überschrift/),
  ).toBeInTheDocument()
  expect(screen.getByLabelText('Text: Vor dem Abschlussfragebogen')).toHaveAttribute(
    'placeholder',
    de.pilot.text_pages.post_intro.body,
  )
  fireEvent.change(title, { target: { value: '' } })
  const form = screen
    .getByRole('heading', { name: 'Texte für Teilnehmer' })
    .closest('.card') as HTMLElement
  fireEvent.click(within(form).getByRole('button', { name: /^Speichern$/ }))
  await waitFor(() =>
    expect(updateStudy).toHaveBeenCalledWith(7, {
      texts: { ...initial.texts, post_intro_title: '' },
    }),
  )
  mounted.unmount()
  view()
  expect(await screen.findByLabelText('Überschrift: Vor dem Abschlussfragebogen')).toHaveValue('')
})
