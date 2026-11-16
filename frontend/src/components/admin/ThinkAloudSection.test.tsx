import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type Study } from '../../api/admin'
import ThinkAloudSection from './ThinkAloudSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return { ...actual, adminApi: { ...actual.adminApi, updateStudy: vi.fn() } }
})

const update = vi.mocked(adminApi.updateStudy)
const study = {
  id: 19,
  flow_version: 'pilot_20261116',
  think_aloud_mode: 'bundled',
  think_aloud_count: 3,
  think_aloud_batch_size: 2,
} as Study

function view(value = study) {
  const client = new QueryClient({ defaultOptions: { mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ThinkAloudSection study={value} />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  update.mockReset().mockResolvedValue(study)
})

test('bundled preview includes the post-case and saves the selected last-X count', async () => {
  view()
  const preview = screen.getByLabelText('Beispiel für die Reihenfolge')
  expect(
    within(preview)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['Trainingsfall 4', 'Trainingsfall 5', 'Nachtestfall'])
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '2' } })
  expect(
    within(preview)
      .getAllByRole('listitem')
      .map((item) => item.textContent),
  ).toEqual(['Trainingsfall 5', 'Nachtestfall'])
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(19, { think_aloud_mode: 'bundled', think_aloud_count: 2 }),
  )
})

test('switching to block mode preserves its own batch size and leaves the bundled count alone', async () => {
  view()
  fireEvent.click(screen.getByRole('radio', { name: /Blockweise während/ }))
  expect(screen.getByRole('spinbutton')).toHaveValue(2)
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '4' } })
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await waitFor(() =>
    expect(update).toHaveBeenCalledWith(19, {
      think_aloud_mode: 'block',
      think_aloud_batch_size: 4,
    }),
  )
  fireEvent.click(screen.getByRole('radio', { name: /Gebündelt nach/ }))
  expect(screen.getByRole('spinbutton')).toHaveValue(3)
})

test('a legacy study cannot silently opt into the pilot flow', async () => {
  view({ ...study, flow_version: 'legacy', think_aloud_mode: 'block' })
  expect(screen.queryByRole('radio')).not.toBeInTheDocument()
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await waitFor(() => expect(update).toHaveBeenCalledWith(19, { think_aloud_batch_size: 2 }))
})

test('invalid counts cannot be saved and a failed save can be retried', async () => {
  update.mockRejectedValueOnce(new Error('offline'))
  view()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } })
  expect(screen.getByRole('button', { name: 'Speichern' })).toBeDisabled()
  fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '3' } })
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  expect(await screen.findByRole('alert')).toHaveTextContent('Konnte nicht gespeichert')
  fireEvent.click(screen.getByRole('button', { name: 'Speichern' }))
  await waitFor(() => expect(update).toHaveBeenCalledTimes(2))
  expect(await screen.findByText('Gespeichert.')).toBeInTheDocument()
})
