import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, vi } from 'vitest'

import SosciScreen from './SosciScreen'

const defaults = {
  variant: 'pretest' as const,
  url: 'https://sosci.example/x',
  idParam: 'id',
  participantId: 'TN-9',
  onContinue: vi.fn(),
}

beforeEach(() => {
  sessionStorage.clear()
  defaults.onContinue.mockClear()
})

afterEach(() => vi.restoreAllMocks())

test.each(['pretest', 'posttest'] as const)(
  '%s requires opening the survey before explicit completion',
  (variant) => {
    render(<SosciScreen {...defaults} variant={variant} />)
    const link = screen.getByRole('link', { name: 'Fragebogen öffnen' })
    const complete = screen.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' })

    expect(link).toHaveAttribute('href', 'https://sosci.example/x?id=TN-9')
    expect(link).toHaveAttribute('target', '_blank')
    expect(link).toHaveAttribute('rel', 'noopener noreferrer')
    expect(link).toHaveAccessibleDescription('Der Fragebogen öffnet sich in einem neuen Tab.')
    expect(complete).toBeDisabled()
    fireEvent.click(complete)
    expect(defaults.onContinue).not.toHaveBeenCalled()

    fireEvent.click(link)
    expect(complete).toBeEnabled()
    expect(defaults.onContinue).not.toHaveBeenCalled()
    fireEvent.click(complete)
    expect(defaults.onContinue).toHaveBeenCalledTimes(1)
  },
)

test('preserves existing survey query parameters and encodes the participant ID', () => {
  render(
    <SosciScreen {...defaults} url="https://sosci.example/x?language=de" participantId="TN 9/&" />,
  )
  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    'https://sosci.example/x?language=de&id=TN%209%2F%26',
  )
})

test('remembers opening the same participant survey across a remount', () => {
  const first = render(<SosciScreen {...defaults} />)
  fireEvent.click(screen.getByRole('link'))
  first.unmount()

  render(<SosciScreen {...defaults} />)
  expect(screen.getByRole('button')).toBeEnabled()
  expect(defaults.onContinue).not.toHaveBeenCalled()
})

test.each([
  ['participant', { participantId: 'TN-10' }],
  ['pre/post variant', { variant: 'posttest' as const }],
  ['survey URL', { url: 'https://sosci.example/another-survey' }],
  ['participant ID parameter', { idParam: 'participant' }],
])('a different %s requires its own opening', (_label, changed) => {
  const { rerender } = render(<SosciScreen {...defaults} />)
  fireEvent.click(screen.getByRole('link'))

  rerender(<SosciScreen {...defaults} {...changed} />)
  expect(screen.getByRole('button')).toBeDisabled()
  fireEvent.click(screen.getByRole('button'))
  expect(defaults.onContinue).not.toHaveBeenCalled()

  fireEvent.click(screen.getByRole('link'))
  expect(screen.getByRole('button')).toBeEnabled()
  rerender(<SosciScreen {...defaults} />)
  expect(screen.getByRole('button')).toBeEnabled()
})

test('keyboard activation opens the native link and enables completion', async () => {
  const user = userEvent.setup()
  render(<SosciScreen {...defaults} />)
  await user.tab()
  expect(screen.getByRole('link')).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button')).toBeEnabled()
  expect(defaults.onContinue).not.toHaveBeenCalled()
})

test('middle-click enables completion without treating a context menu as opening', () => {
  render(<SosciScreen {...defaults} />)
  const link = screen.getByRole('link')
  fireEvent.contextMenu(link)
  fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 2 }))
  expect(screen.getByRole('button')).toBeDisabled()

  fireEvent(link, new MouseEvent('auxclick', { bubbles: true, button: 1 }))
  expect(screen.getByRole('button')).toBeEnabled()
  expect(defaults.onContinue).not.toHaveBeenCalled()
})

test('Ctrl-click keeps native new-tab navigation and enables completion', () => {
  render(<SosciScreen {...defaults} />)
  expect(fireEvent.click(screen.getByRole('link'), { ctrlKey: true })).toBe(true)
  expect(screen.getByRole('button')).toBeEnabled()
})

test('unavailable session storage falls back to scoped in-memory state', () => {
  vi.spyOn(window, 'sessionStorage', 'get').mockImplementation(() => {
    throw new DOMException('Storage blocked', 'SecurityError')
  })
  const { rerender, unmount } = render(<SosciScreen {...defaults} />)
  expect(screen.getByRole('button')).toBeDisabled()
  fireEvent.click(screen.getByRole('link'))
  expect(screen.getByRole('button')).toBeEnabled()
  fireEvent.click(screen.getByRole('button'))
  expect(defaults.onContinue).toHaveBeenCalledTimes(1)

  rerender(<SosciScreen {...defaults} participantId="TN-10" />)
  expect(screen.getByRole('button')).toBeDisabled()
  unmount()
  render(<SosciScreen {...defaults} />)
  expect(screen.getByRole('button')).toBeDisabled()
})

test('a storage write failure does not prevent opening or completion', () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new DOMException('Storage full', 'QuotaExceededError')
  })
  render(<SosciScreen {...defaults} />)
  fireEvent.click(screen.getByRole('link'))
  expect(screen.getByRole('button')).toBeEnabled()
  fireEvent.click(screen.getByRole('button'))
  expect(defaults.onContinue).toHaveBeenCalledTimes(1)
})

test('keeps the approved pilot post wording while pre-test retains the ID sentence', () => {
  const { rerender } = render(<SosciScreen {...defaults} pilot />)
  expect(screen.getByText(/Ihre Teilnehmer-ID wird automatisch übergeben/)).toBeVisible()
  rerender(<SosciScreen {...defaults} variant="posttest" pilot />)
  expect(screen.queryByText(/Ihre Teilnehmer-ID wird/)).not.toBeInTheDocument()
  expect(screen.getByRole('heading', { name: 'Abschluss-Fragebogen' })).toBeVisible()
  expect(screen.getByRole('link', { name: 'Fragebogen öffnen' })).toBeVisible()
  expect(
    screen.getByRole('button', { name: 'Ich habe den Fragebogen abgeschlossen' }),
  ).toBeDisabled()
})
