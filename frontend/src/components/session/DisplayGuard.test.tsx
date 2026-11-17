import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  continueWithUnverifiedDisplay,
  resumeDisplayGuard,
  type DisplayGuardSnapshot,
} from '../../lib/displayGuard'
import DisplayGuard from './DisplayGuard'
import { nativeViewport, type NativeViewportState } from '../../lib/nativeViewport'
import { APP_VERSION } from '../../lib/appVersion'

let state: DisplayGuardSnapshot
let native: NativeViewportState
let permission: PermissionState | null
const permissionListeners = new Set<(value: PermissionState | null) => void>()
vi.mock('../../lib/nativeViewport', async (original) => ({
  ...(await original<typeof import('../../lib/nativeViewport')>()),
  getNativeViewportSnapshot: () => native,
  subscribeNativeViewport: () => () => {},
  nativeViewport: { retry: vi.fn() },
}))
vi.mock('../../lib/bridgePermission', async (original) => ({
  ...(await original<typeof import('../../lib/bridgePermission')>()),
  observeLoopbackPermission: (callback: (value: PermissionState | null) => void) => {
    permissionListeners.add(callback)
    callback(permission)
    return () => {
      permissionListeners.delete(callback)
    }
  },
}))
vi.mock('../../lib/displayGuard', async (original) => ({
  ...(await original<typeof import('../../lib/displayGuard')>()),
  checkDisplayGuard: () =>
    !state.enabled || !state.required || state.phase === 'verified' || state.unverifiedContinuation,
  getDisplayGuardSnapshot: () => state,
  resumeDisplayGuard: vi.fn(),
  continueWithUnverifiedDisplay: vi.fn(),
}))

beforeEach(() => {
  vi.clearAllMocks()
  native = {
    owner: null,
    capable: false,
    tabId: null,
    proof: null,
    errorCode: null,
    connection: 'idle',
  }
  permission = null
  permissionListeners.clear()
  state = {
    enabled: true,
    required: true,
    focusRequired: true,
    phase: 'blocked',
    owner: 'P1',
    reasons: ['window_size'],
    generation: 1,
    unverifiedContinuation: false,
  }
})
afterEach(() => vi.unstubAllGlobals())

test('a blocked overlay cannot be dismissed and requires explicit confirmation after restoration', () => {
  const click = vi.fn()
  const { rerender, container } = render(
    <DisplayGuard state={state}>
      <button onClick={click}>Task action</button>
    </DisplayGuard>,
  )
  const dialog = screen.getByRole('dialog', { name: 'Bildschirmeinstellung prüfen' })
  expect(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' })).toBeDisabled()
  fireEvent.keyDown(dialog, { key: 'Escape' })
  fireEvent.click(dialog)
  expect(dialog).toBeInTheDocument()
  const content = container.querySelector('.display-guard__content') as HTMLElement
  expect(content.inert).toBe(true)
  expect(content).toHaveAttribute('aria-hidden', 'true')
  fireEvent.click(screen.getByText('Task action'))
  expect(click).not.toHaveBeenCalled()
  const reset = new KeyboardEvent('keydown', {
    key: '0',
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  })
  content.dispatchEvent(reset)
  expect(reset.defaultPrevented).toBe(false)

  state = { ...state, phase: 'ready' }
  rerender(
    <DisplayGuard state={state}>
      <button onClick={click}>Task action</button>
    </DisplayGuard>,
  )
  expect(resumeDisplayGuard).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' }))
  expect(resumeDisplayGuard).toHaveBeenCalledOnce()
  expect(content.inert).toBe(true)
  state = { ...state, phase: 'verified' }
  rerender(
    <DisplayGuard state={state}>
      <button onClick={click}>Task action</button>
    </DisplayGuard>,
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect(content.inert).toBe(false)
  fireEvent.click(screen.getByText('Task action'))
  expect(click).toHaveBeenCalledOnce()
})

test('disabled guard adds no wrapper to normal pages and exempt steps remain usable', () => {
  state = { ...state, enabled: false, phase: 'disabled' }
  const { container, rerender } = render(
    <DisplayGuard state={state}>
      <main>Page</main>
    </DisplayGuard>,
  )
  expect(container.innerHTML).toBe('<main>Page</main>')
  state = { ...state, enabled: true, required: false, phase: 'suspended' }
  rerender(
    <DisplayGuard state={state}>
      <main>Page</main>
    </DisplayGuard>,
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect((container.querySelector('.display-guard__content') as HTMLElement).inert).toBe(false)
})

test('blocked form changes and clipboard input cannot reach participant answer handlers', () => {
  const change = vi.fn()
  const paste = vi.fn()
  const drop = vi.fn()
  render(
    <DisplayGuard state={state}>
      <input aria-label="Answer" onChange={change} onPaste={paste} onDrop={drop} />
    </DisplayGuard>,
  )
  const answer = screen.getByLabelText('Answer')
  fireEvent.change(answer, { target: { value: 'Unverified' } })
  fireEvent.paste(answer)
  fireEvent.drop(answer)
  expect(change).not.toHaveBeenCalled()
  expect(paste).not.toHaveBeenCalled()
  expect(drop).not.toHaveBeenCalled()
})

test('a failed display check always offers explicit unverified continuation and reports the reason', () => {
  const click = vi.fn()
  const { rerender, container } = render(
    <DisplayGuard state={state}>
      <button onClick={click}>Task action</button>
    </DisplayGuard>,
  )
  const proceed = screen.getByRole('button', { name: 'Mit aktueller Anzeige fortfahren' })
  expect(proceed).toBeEnabled()
  expect(
    screen.getByText('Die gemeldete Browserfläche entspricht nicht 1920 × 1080 Pixeln.'),
  ).toBeVisible()
  expect(
    screen.getByText(/Nicht verifizierte Blickdaten werden nicht für die AOI-Auswertung verwendet/),
  ).toBeVisible()
  fireEvent.click(proceed)
  expect(continueWithUnverifiedDisplay).toHaveBeenCalledOnce()
  expect(resumeDisplayGuard).not.toHaveBeenCalled()
  state = { ...state, unverifiedContinuation: true }
  rerender(
    <DisplayGuard state={state}>
      <button onClick={click}>Task action</button>
    </DisplayGuard>,
  )
  expect(screen.queryByRole('dialog')).toBeNull()
  expect((container.querySelector('.display-guard__content') as HTMLElement).inert).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Task action' }))
  expect(click).toHaveBeenCalledOnce()
})

test('unreachable bridge explains recovery before geometry and retry does not approve or discard answers', () => {
  native = {
    ...native,
    owner: state.owner,
    connection: 'unreachable',
    errorCode: 'bridge_unreachable',
  }
  const change = vi.fn()
  render(
    <DisplayGuard state={state}>
      <input aria-label="Answer" defaultValue="Saved draft" onChange={change} />
    </DisplayGuard>,
  )
  expect(screen.getByText('Die Windows-Bridge auf diesem PC ist nicht erreichbar.')).toBeVisible()
  expect(screen.getByText(/Starten Sie die aktuelle Windows-Bridge/)).toBeVisible()
  expect(
    screen.queryByText('Die gemeldete Browserfläche entspricht nicht 1920 × 1080 Pixeln.'),
  ).toBeNull()
  expect(screen.queryByText(/Vorgesehen sind 1920 × 1080/)).toBeNull()
  expect(
    screen.getByRole('link', { name: 'Aktuelle Windows-Bridge herunterladen' }),
  ).toHaveAttribute('href', '/downloads/A04Bridge-native-20261117.zip')
  fireEvent.click(screen.getByRole('button', { name: 'Bridge erneut verbinden' }))
  expect(nativeViewport.retry).toHaveBeenCalledOnce()
  expect(resumeDisplayGuard).not.toHaveBeenCalled()
  expect(continueWithUnverifiedDisplay).not.toHaveBeenCalled()
  expect(screen.getByLabelText('Answer')).toHaveValue('Saved draft')
  expect(change).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' })).toBeDisabled()
})

test('a denied local network permission has specific guidance and a pending permission keeps retry disabled', async () => {
  permission = 'denied'
  native = {
    ...native,
    owner: state.owner,
    connection: 'unreachable',
    errorCode: 'bridge_unreachable',
  }
  const { rerender } = render(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  expect(await screen.findByText(/Edge blockiert den Zugriff auf die lokale Bridge/)).toBeVisible()
  native = { ...native, connection: 'permission_pending', errorCode: 'checking_display' }
  rerender(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  expect(screen.getByText('Bitte die lokale Netzwerkfreigabe in Edge bestätigen.')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Bridge erneut verbinden' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' })).toBeDisabled()
  expect(screen.getByText('Laufende Zeitbegrenzungen gelten weiterhin.')).toBeVisible()
})

test.each([
  ['viewport_size_mismatch', /Browserfläche konnte nicht eindeutig gemessen/],
  ['viewport_ambiguous', /Browserfläche konnte nicht eindeutig gemessen/],
  ['not_foreground', /Bringen Sie dieses Studienfenster in den Vordergrund/],
  ['multiple_displays', /Verwenden Sie nur den kalibrierten Bildschirm/],
  ['unsupported_platform', /Windows, Edge und die aktuelle Windows-Bridge/],
  ['tab_owned', /Eine andere Studienseite beansprucht/],
])('native failure %s explains the repair without enabling continuation', (errorCode, message) => {
  native = { ...native, owner: state.owner, capable: true, connection: 'connected', errorCode }
  state = { ...state, profile: 'native_viewport_v1', reasons: ['native_measurement'] }
  render(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  expect(screen.getByText(message)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' })).toBeDisabled()
})

test('an old bridge explains the upgrade while the verified legacy fullscreen path remains usable', () => {
  native = {
    ...native,
    owner: state.owner,
    connection: 'upgrade_required',
    errorCode: 'bridge_upgrade_required',
  }
  state = { ...state, phase: 'ready', profile: 'lab_1080p' }
  render(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  expect(screen.getByText(/Beenden Sie die bisherige Bridge vollständig/)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' })).toBeEnabled()
  fireEvent.click(screen.getByRole('button', { name: 'Studienleitung: Fortsetzen' }))
  expect(resumeDisplayGuard).toHaveBeenCalledOnce()
  expect(continueWithUnverifiedDisplay).not.toHaveBeenCalled()
})

test('copied diagnostics include software and connection state but omit all participant and tab identifiers', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  state = { ...state, owner: 'private-participant-id' }
  native = {
    ...native,
    owner: state.owner,
    capable: true,
    tabId: 'a'.repeat(32),
    connection: 'unreachable',
    errorCode: 'bridge_unreachable',
  }
  document.title = 'Private page title'
  render(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  fireEvent.click(screen.getByText(`Technischer Status · Version ${APP_VERSION}`))
  fireEvent.click(screen.getByRole('button', { name: 'Diagnose kopieren' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
  const text = String(writeText.mock.calls[0][0])
  expect(JSON.parse(text)).toMatchObject({
    app_version: APP_VERSION,
    app_bundle: 'development',
    bridge_connection: 'unreachable',
    bridge_error: 'bridge_unreachable',
    native_capability: true,
  })
  for (const privateValue of ['private-participant-id', 'a'.repeat(32), 'Private page title'])
    expect(text).not.toContain(privateValue)
  expect(await screen.findByText('Diagnose wurde kopiert.')).toBeVisible()
})

test('a permission grant arriving after the bridge handshake updates copied diagnostics', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  permission = 'denied'
  native = {
    ...native,
    owner: state.owner,
    connection: 'unreachable',
    errorCode: 'bridge_unreachable',
  }
  const { rerender, unmount } = render(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  expect(await screen.findByText(/Edge blockiert den Zugriff auf die lokale Bridge/)).toBeVisible()
  const observer = [...permissionListeners][0]
  native = { ...native, capable: true, connection: 'connected', errorCode: 'checking_display' }
  rerender(
    <DisplayGuard state={state}>
      <main>Task</main>
    </DisplayGuard>,
  )
  expect([...permissionListeners]).toEqual([observer])
  act(() => {
    for (const listener of permissionListeners) listener('granted')
  })
  fireEvent.click(screen.getByText(`Technischer Status · Version ${APP_VERSION}`))
  fireEvent.click(screen.getByRole('button', { name: 'Diagnose kopieren' }))
  await waitFor(() => expect(writeText).toHaveBeenCalledOnce())
  expect(JSON.parse(String(writeText.mock.calls[0][0]))).toMatchObject({
    bridge_connection: 'connected',
    loopback_permission: 'granted',
  })
  unmount()
  expect(permissionListeners.size).toBe(0)
})
