import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import { useClientDiagnostics } from './useClientDiagnostics'
import { enqueue } from '../lib/outbox'

const fixture = vi.hoisted(() => ({
  state: {
    owner: 'participant',
    connection: 'unreachable',
    capable: false,
    errorCode: 'bridge_unreachable',
    tabId: 'PRIVATE_NONCE',
    proof: { id: 'PRIVATE_PROOF' },
  },
  changed: null as null | (() => void),
  permission: null as null | ((value: PermissionState | null) => void),
  stopNative: vi.fn(),
  stopPermission: vi.fn(),
}))
vi.mock('../lib/displayGuard', () => ({ DISPLAY_GUARD_ENABLED: true }))
vi.mock('../lib/nativeViewport', () => ({
  getNativeViewportSnapshot: () => fixture.state,
  subscribeNativeViewport: (changed: () => void) => {
    fixture.changed = changed
    return fixture.stopNative
  },
}))
vi.mock('../lib/bridgePermission', () => ({
  observeLoopbackPermission: (changed: (value: PermissionState | null) => void) => {
    fixture.permission = changed
    return fixture.stopPermission
  },
}))
vi.mock('../lib/outbox', () => ({ enqueue: vi.fn() }))
afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

test('reports blocked bridge and permission failures without participant or native IDs', () => {
  const view = renderHook(() => useClientDiagnostics('participant'))
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: 'display_connection_status',
      payload: expect.objectContaining({
        bridge_connection: 'unreachable',
        bridge_error: 'bridge_unreachable',
      }),
    }),
  )
  act(() => fixture.permission?.('denied'))
  expect(enqueue).toHaveBeenLastCalledWith(
    'event',
    expect.objectContaining({
      payload: expect.objectContaining({ loopback_permission: 'denied' }),
    }),
  )
  act(() => {
    for (let i = 0; i < 100; i++) fixture.changed?.()
  })
  expect(enqueue).toHaveBeenCalledTimes(2)
  const sent = JSON.stringify(vi.mocked(enqueue).mock.calls)
  expect(sent).not.toContain('participant')
  expect(sent).not.toContain('PRIVATE_')
  view.unmount()
  expect(fixture.stopNative).toHaveBeenCalledOnce()
  expect(fixture.stopPermission).toHaveBeenCalledOnce()
})

test('never attributes another participant’s connection to a new owner', () => {
  renderHook(() => useClientDiagnostics('different-participant'))
  act(() => fixture.permission?.('granted'))
  expect(enqueue).not.toHaveBeenCalled()
})
