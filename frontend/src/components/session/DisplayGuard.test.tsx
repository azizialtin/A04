import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import {
  continueWithUnverifiedDisplay,
  resumeDisplayGuard,
  type DisplayGuardSnapshot,
} from '../../lib/displayGuard'
import DisplayGuard from './DisplayGuard'

let state: DisplayGuardSnapshot
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
