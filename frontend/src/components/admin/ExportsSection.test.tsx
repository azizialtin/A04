import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, EXPORT_KINDS, type AdminParticipant, type ExportInfo } from '../../api/admin'
import ExportsSection from './ExportsSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listExports: vi.fn(),
      downloadExport: vi.fn(),
      listParticipants: vi.fn(),
    },
  }
})

const listExports = vi.mocked(adminApi.listExports)
const downloadExport = vi.mocked(adminApi.downloadExport)
const listParticipants = vi.mocked(adminApi.listParticipants)

const PEOPLE: AdminParticipant[] = ['TN-001', 'TN-002', 'TN-003'].map((id) => ({
  id,
  status: 'active',
  slot_count: 9,
  video_set_id: 1,
  video_set_name: 'Set A',
}))

const CATALOGUE: ExportInfo[] = EXPORT_KINDS.map((kind) => ({
  kind,
  filename: `${kind}.csv`,
  rows: kind === 'calibration' ? 0 : 12,
  collected: kind !== 'calibration',
}))

function view(preselected: string | null = null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ExportsSection studyId={9} preselected={preselected} />
    </QueryClientProvider>,
  )
}

const rowFor = (kind: string) => screen.getByText(`${kind}.csv`).closest('tr') as HTMLElement

beforeEach(() => {
  listExports.mockReset().mockResolvedValue(CATALOGUE)
  downloadExport.mockReset().mockResolvedValue(undefined)
  listParticipants.mockReset().mockResolvedValue(PEOPLE)
})

test('says how many rows each export holds', async () => {
  view()
  await waitFor(() => expect(within(rowFor('notes')).getByText('12')).toBeInTheDocument())
})

test('explains the empty calibration file rather than leaving it a mystery', async () => {
  view()

  const row = await waitFor(() => {
    const found = rowFor('calibration')
    expect(within(found).getByText('0')).toBeInTheDocument()
    return found
  })
  expect(within(row).getByText(/Eye Tracker Manager/)).toBeInTheDocument()
})

test('downloads the file that was asked for', async () => {
  view()
  await waitFor(() => expect(rowFor('events')).toBeInTheDocument())

  fireEvent.click(within(rowFor('events')).getByRole('button', { name: 'Herunterladen' }))
  // Everyone is chosen, so no filter travels with the request.
  expect(downloadExport).toHaveBeenCalledWith(9, 'events', undefined)
})

const checkbox = (id: string) => screen.getByLabelText(id) as HTMLInputElement

test('starts with everyone chosen and narrows the counts and the download together', async () => {
  view()
  await waitFor(() => expect(checkbox('TN-003')).toBeChecked())
  expect(screen.getByText('3 von 3 ausgewählt')).toBeInTheDocument()
  expect(listExports).toHaveBeenLastCalledWith(9, undefined)

  fireEvent.click(checkbox('TN-001'))
  fireEvent.click(checkbox('TN-002'))

  expect(screen.getByText('1 von 3 ausgewählt')).toBeInTheDocument()
  await waitFor(() => expect(listExports).toHaveBeenLastCalledWith(9, ['TN-003']))

  fireEvent.click(within(rowFor('notes')).getByRole('button', { name: 'Herunterladen' }))
  expect(downloadExport).toHaveBeenCalledWith(9, 'notes', ['TN-003'])
})

test('a preselected participant arrives as the only one chosen', async () => {
  view('TN-002')
  await waitFor(() => expect(checkbox('TN-002')).toBeChecked())
  expect(checkbox('TN-001')).not.toBeChecked()
  expect(checkbox('TN-003')).not.toBeChecked()
  await waitFor(() => expect(listExports).toHaveBeenLastCalledWith(9, ['TN-002']))
})

test('with nobody chosen there is nothing to download', async () => {
  view()
  await waitFor(() => expect(checkbox('TN-001')).toBeChecked())

  fireEvent.click(screen.getByRole('button', { name: 'Keine' }))

  expect(screen.getByText(/Keine Person ausgewählt/)).toBeInTheDocument()
  expect(within(rowFor('events')).getByRole('button', { name: 'Herunterladen' })).toBeDisabled()
  // "Alle" brings everyone back.
  fireEvent.click(screen.getByRole('button', { name: 'Alle' }))
  expect(screen.getByText('3 von 3 ausgewählt')).toBeInTheDocument()
})

test('the id filter narrows the list without changing the selection', async () => {
  view()
  await waitFor(() => expect(checkbox('TN-003')).toBeChecked())

  fireEvent.change(screen.getByLabelText('Teilnehmer-IDs filtern'), { target: { value: '003' } })

  expect(screen.queryByLabelText('TN-001')).not.toBeInTheDocument()
  expect(checkbox('TN-003')).toBeChecked()
  expect(screen.getByText('3 von 3 ausgewählt')).toBeInTheDocument()
})
