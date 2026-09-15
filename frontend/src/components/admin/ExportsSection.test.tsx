import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, EXPORT_KINDS, type ExportInfo } from '../../api/admin'
import ExportsSection from './ExportsSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: { ...actual.adminApi, listExports: vi.fn(), downloadExport: vi.fn() },
  }
})

const listExports = vi.mocked(adminApi.listExports)
const downloadExport = vi.mocked(adminApi.downloadExport)

const CATALOGUE: ExportInfo[] = EXPORT_KINDS.map((kind) => ({
  kind,
  filename: `${kind}.csv`,
  rows: kind === 'calibration' ? 0 : 12,
  collected: kind !== 'calibration',
}))

function view() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <ExportsSection studyId={9} />
    </QueryClientProvider>,
  )
}

const rowFor = (kind: string) => screen.getByText(`${kind}.csv`).closest('tr') as HTMLElement

beforeEach(() => {
  listExports.mockReset().mockResolvedValue(CATALOGUE)
  downloadExport.mockReset().mockResolvedValue(undefined)
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
  expect(downloadExport).toHaveBeenCalledWith(9, 'events')
})
