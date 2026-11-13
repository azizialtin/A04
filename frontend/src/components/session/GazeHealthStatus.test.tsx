import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import GazeHealthStatus from './GazeHealthStatus'
const descriptor = Object.getOwnPropertyDescriptor(navigator, 'permissions')
afterEach(() => {
  if (descriptor) Object.defineProperty(navigator, 'permissions', descriptor)
  else Reflect.deleteProperty(navigator, 'permissions')
})
function permissions(query: unknown) {
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } })
}
test('granular loopback denial is never hidden by a legacy prompt result', async () => {
  const status = Object.assign(new EventTarget(), { state: 'denied' })
  const query = vi.fn().mockResolvedValue(status)
  permissions(query)
  const retry = vi.fn()
  render(
    <GazeHealthStatus
      health={{ state: 'bridge_unreachable', received: 0, valid: 0 }}
      retry={retry}
      preflight
    />,
  )
  await waitFor(() => expect(screen.getByText(/Browser meldet gesperrten/)).toBeVisible())
  expect(query).toHaveBeenCalledTimes(1)
  expect(query).toHaveBeenLastCalledWith({ name: 'loopback-network' })
  fireEvent.click(screen.getByRole('button', { name: 'Eye-Tracker erneut prüfen' }))
  expect(retry).toHaveBeenCalledOnce()
})
test('unsupported permission APIs leave actionable guidance without claiming denial', async () => {
  const query = vi.fn().mockRejectedValue(new TypeError('unknown permission'))
  permissions(query)
  render(
    <GazeHealthStatus
      health={{ state: 'bridge_unreachable', received: 0, valid: 0 }}
      retry={() => {}}
    />,
  )
  await waitFor(() => expect(query).toHaveBeenCalledTimes(2))
  expect(screen.getByText(/A04Bridge.exe starten/)).toBeVisible()
  expect(screen.queryByText(/Browser meldet gesperrten/)).toBeNull()
})
test('mock samples are explicitly labeled and raw counts do not substitute for valid positions', () => {
  render(
    <GazeHealthStatus
      health={{ state: 'invalid_samples', received: 500, valid: 0, mock: true }}
      retry={() => {}}
    />,
  )
  expect(screen.getByRole('status')).toHaveTextContent('Testmodus')
  expect(screen.getByRole('status')).toHaveTextContent(
    '500 empfangen · 0 mit gültiger Augenposition',
  )
  expect(screen.getByRole('status')).toHaveAttribute('data-aoi-overlay', 'true')
})
