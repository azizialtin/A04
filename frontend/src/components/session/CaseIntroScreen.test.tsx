import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import CaseIntroScreen from './CaseIntroScreen'

// A fresh spy per test rather than one that is reset: in vitest 2 a spy that
// has been cleared or reset reports a rejecting implementation as an unhandled
// rejection even when the caller catches it.
let prepareCapture = vi.fn()

vi.mock('../../lib/screenCapture', () => ({
  bridgeCanRecord: vi.fn().mockResolvedValue(false),
  prepareCapture: () => prepareCapture(),
}))

beforeEach(() => {
  prepareCapture = vi.fn()
})

test('secures a screen capture before moving on to the clip', async () => {
  let release: () => void = () => {}
  prepareCapture.mockReturnValue(new Promise<void>((resolve) => (release = resolve)))
  const onContinue = vi.fn()
  render(<CaseIntroScreen onContinue={onContinue} />)

  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))

  // The picker is up: the case must not start underneath it.
  await waitFor(() => expect(prepareCapture).toHaveBeenCalled())
  expect(onContinue).not.toHaveBeenCalled()
  expect(screen.getByRole('button')).toBeDisabled()

  release()
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
})

test('a capture that cannot be arranged does not hold the run up', async () => {
  prepareCapture.mockImplementation(() => Promise.reject(new Error('no display')))
  const onContinue = vi.fn()
  render(<CaseIntroScreen onContinue={onContinue} />)

  fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
  await waitFor(() => expect(onContinue).toHaveBeenCalledTimes(1))
})

test("shows the study's own wording when it has any, and the default otherwise", () => {
  const { unmount } = render(
    <CaseIntroScreen
      title="Nächster Fall"
      body={'Erster Absatz.\n\nZweiter.'}
      onContinue={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Nächster Fall' })).toBeInTheDocument()
  expect(screen.getByText('Erster Absatz.')).toBeInTheDocument()
  expect(screen.getByText('Zweiter.')).toBeInTheDocument()
  unmount()

  render(<CaseIntroScreen title="" body="" onContinue={vi.fn()} />)
  expect(screen.getByRole('heading', { name: 'Neuer Fall' })).toBeInTheDocument()
  expect(screen.getByText(/Gleich sehen Sie ein neues Video/)).toBeInTheDocument()
})
