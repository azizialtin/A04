import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test, vi } from 'vitest'

import { adminApi } from '../../api/admin'
import AdminStudyListPage from './AdminStudyListPage'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return { ...actual, adminApi: { ...actual.adminApi, listStudies: vi.fn(), createStudy: vi.fn() } }
})

test('new study fields expose their visible names and submit values from those controls', async () => {
  vi.mocked(adminApi.listStudies).mockResolvedValue([])
  vi.mocked(adminApi.createStudy).mockResolvedValue({ id: 1 } as never)
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AdminStudyListPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  const fields = [
    ['Name', 'Accessible study'],
    ['SoSci-Link (Vortest)', 'https://example.test/pre'],
    ['SoSci-Link (Nachtest)', 'https://example.test/post'],
  ] as const
  for (const [name, value] of fields) {
    const input = screen.getByRole('textbox', { name })
    fireEvent.change(input, { target: { value } })
    expect(input).toHaveValue(value)
  }
  fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }))
  await waitFor(() =>
    expect(adminApi.createStudy).toHaveBeenCalledWith({
      name: 'Accessible study',
      sosci_pretest_url: 'https://example.test/pre',
      sosci_posttest_url: 'https://example.test/post',
    }),
  )
})
