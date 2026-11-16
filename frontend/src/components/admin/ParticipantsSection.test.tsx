import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { expect, test, vi } from 'vitest'

import { adminApi } from '../../api/admin'
import ParticipantsSection from './ParticipantsSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listParticipants: vi.fn(),
      listVideos: vi.fn(),
      createParticipants: vi.fn(),
    },
  }
})

test('ID generator and manual IDs have accessible names and preserve generated values on save', async () => {
  vi.mocked(adminApi.listParticipants).mockResolvedValue([])
  vi.mocked(adminApi.listVideos).mockResolvedValue([])
  vi.mocked(adminApi.createParticipants).mockResolvedValue({
    created: ['QA-001', 'QA-002'],
    skipped: [],
  })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ParticipantsSection studyId={7} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.change(screen.getByRole('textbox', { name: 'ID-Präfix' }), {
    target: { value: 'QA-' },
  })
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Anzahl der IDs' }), {
    target: { value: '2' },
  })
  fireEvent.click(screen.getByRole('checkbox', { name: /Fortlaufend nummerieren/ }))
  fireEvent.click(screen.getByRole('button', { name: 'IDs erzeugen' }))
  expect(screen.getByRole('textbox', { name: 'IDs (eine pro Zeile)' })).toHaveValue(
    'QA-001\nQA-002',
  )
  fireEvent.click(screen.getByRole('button', { name: 'Anlegen' }))
  await waitFor(() =>
    expect(adminApi.createParticipants).toHaveBeenCalledWith(7, ['QA-001', 'QA-002']),
  )
})
