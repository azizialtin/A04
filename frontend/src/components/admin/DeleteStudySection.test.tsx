import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type AdminVideo, type Study, type StudyStats } from '../../api/admin'
import { ToastProvider } from '../Toast'
import DeleteStudySection from './DeleteStudySection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      studyStats: vi.fn(),
      listVideos: vi.fn(),
      deleteStudy: vi.fn(),
    },
  }
})

const studyStats = vi.mocked(adminApi.studyStats)
const listVideos = vi.mocked(adminApi.listVideos)
const deleteStudy = vi.mocked(adminApi.deleteStudy)

const STUDY = { id: 9, name: 'TEST-Pilot 2026' } as Study

const STATS = {
  participants: { total: 3, started: 2 },
  data: { responses: 12, notes: 7, diagnoses: 4, gaze_recordings: 5, screens_stored: 6 },
} as unknown as StudyStats

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <MemoryRouter initialEntries={['/admin/studies/9']}>
          <Routes>
            <Route path="/admin/studies/9" element={<DeleteStudySection study={STUDY} />} />
            <Route path="/admin/studies" element={<p>Studienliste</p>} />
          </Routes>
        </MemoryRouter>
      </ToastProvider>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  studyStats.mockReset().mockResolvedValue(STATS)
  listVideos.mockReset().mockResolvedValue([{ id: 1 }, { id: 2 }] as AdminVideo[])
  deleteStudy.mockReset().mockResolvedValue({ status: 'ok' })
})

test('the dialog counts what goes, and deletes only once the exact name is typed', async () => {
  view()
  expect(deleteStudy).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('button', { name: 'Studie löschen…' }))
  const dialog = screen.getByRole('dialog', { name: 'Studie löschen' })
  expect(dialog).toBeInTheDocument()
  await screen.findByText('3 Teilnehmer, davon 2 mit begonnenem Durchlauf')
  expect(screen.getByText('2 Videos samt Dateien')).toBeInTheDocument()
  expect(screen.getByText('12 Fragebogen-Antworten, 7 Notizen, 4 Diagnosen')).toBeInTheDocument()
  expect(screen.getByText('5 Blickaufzeichnungen und 6 Bildschirmaufnahmen')).toBeInTheDocument()

  const confirm = screen.getByRole('button', { name: 'Endgültig löschen' })
  expect(confirm).toBeDisabled()

  const input = screen.getByLabelText(/Namen der Studie/)
  fireEvent.change(input, { target: { value: 'TEST-Pilot' } })
  expect(confirm).toBeDisabled()
  fireEvent.change(input, { target: { value: '  TEST-Pilot 2026 ' } })
  expect(confirm).toBeEnabled()

  fireEvent.click(confirm)
  await waitFor(() => expect(deleteStudy).toHaveBeenCalledWith(9, true))
  // Gone, so the page leaves for the list.
  await screen.findByText('Studienliste')
  expect(screen.getByText('Studie „TEST-Pilot 2026“ gelöscht.')).toBeInTheDocument()
})

test('cancelling closes the dialog without touching the study', () => {
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Studie löschen…' }))
  fireEvent.click(screen.getByRole('button', { name: 'Abbrechen' }))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(deleteStudy).not.toHaveBeenCalled()
})

test('a failure is shown in the dialog, which stays open', async () => {
  deleteStudy.mockRejectedValue({ response: { status: 500, data: { detail: 'Storage down' } } })
  view()
  fireEvent.click(screen.getByRole('button', { name: 'Studie löschen…' }))
  fireEvent.change(screen.getByLabelText(/Namen der Studie/), {
    target: { value: 'TEST-Pilot 2026' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Endgültig löschen' }))

  await screen.findByText(/Die Studie konnte nicht gelöscht werden\. Storage down/)
  expect(screen.getByRole('dialog', { name: 'Studie löschen' })).toBeInTheDocument()
  expect(screen.queryByText('Studienliste')).not.toBeInTheDocument()
})
