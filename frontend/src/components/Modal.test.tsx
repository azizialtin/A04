import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { vi } from 'vitest'

import Modal from './Modal'

test('renders children when open, hides when closed, and closes on the button', () => {
  const onClose = vi.fn()
  const { rerender } = render(
    <Modal open title="Info" onClose={onClose}>
      <p>hello</p>
    </Modal>,
  )
  expect(screen.getByText('hello')).toBeInTheDocument()

  fireEvent.click(screen.getByRole('button', { name: 'Schließen' }))
  expect(onClose).toHaveBeenCalledTimes(1)

  rerender(
    <Modal open={false} title="Info" onClose={onClose}>
      <p>hello</p>
    </Modal>,
  )
  expect(screen.queryByText('hello')).not.toBeInTheDocument()
})

test('keeps keyboard focus inside, skips unavailable controls and restores the opener', async () => {
  const user = userEvent.setup()
  const trigger = document.createElement('button')
  trigger.textContent = 'Open'
  document.body.append(trigger)
  trigger.focus()
  const onClose = vi.fn()
  const { rerender, unmount } = render(
    <Modal open title="Confirm" onClose={onClose}>
      <input aria-label="Answer" />
      <button disabled>Disabled</button>
      <button style={{ display: 'none' }}>Hidden</button>
      <button>Confirm</button>
    </Modal>,
  )
  const close = screen.getByRole('button', { name: 'Schließen' })
  const confirm = screen.getByRole('button', { name: 'Confirm' })
  expect(close).toHaveFocus()
  await user.tab({ shift: true })
  expect(confirm).toHaveFocus()
  await user.tab()
  expect(close).toHaveFocus()
  await user.tab()
  expect(screen.getByRole('textbox', { name: 'Answer' })).toHaveFocus()
  await user.tab()
  expect(confirm).toHaveFocus()
  trigger.focus()
  expect(close).toHaveFocus()
  await user.keyboard('{Escape}')
  expect(onClose).toHaveBeenCalledTimes(1)
  rerender(
    <Modal open={false} title="Confirm" onClose={onClose}>
      Closed
    </Modal>,
  )
  expect(trigger).toHaveFocus()
  unmount()
  trigger.remove()
})

test('preserves child autofocus and does not reset focus when callbacks change', () => {
  const trigger = document.createElement('button')
  document.body.append(trigger)
  trigger.focus()
  const { rerender, unmount } = render(
    <Modal open title="Edit" onClose={vi.fn()}>
      <input aria-label="Name" autoFocus />
    </Modal>,
  )
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  rerender(
    <Modal open title="Edit" onClose={vi.fn()}>
      <input aria-label="Name" autoFocus />
    </Modal>,
  )
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  unmount()
  expect(trigger).toHaveFocus()
  trigger.remove()
})

test('restores the current opener when a mounted dialog opens again with child autofocus', () => {
  const first = document.createElement('button')
  const second = document.createElement('button')
  document.body.append(first, second)
  const onClose = vi.fn()
  const modal = (open: boolean) => (
    <Modal open={open} title="Edit" onClose={onClose}>
      <input aria-label="Name" autoFocus />
    </Modal>
  )
  const { rerender, unmount } = render(modal(false))
  first.focus()
  rerender(modal(true))
  expect(screen.getByRole('textbox', { name: 'Name' })).toHaveFocus()
  rerender(modal(false))
  expect(first).toHaveFocus()
  second.focus()
  rerender(modal(true))
  rerender(modal(false))
  expect(second).toHaveFocus()
  unmount()
  first.remove()
  second.remove()
})

test('only the top dialog handles Escape and closing it restores focus to its parent', async () => {
  const user = userEvent.setup()
  const closeOuter = vi.fn()
  const closeInner = vi.fn()
  const outer = render(
    <Modal open title="Outer" onClose={closeOuter}>
      <button>Outer action</button>
    </Modal>,
  )
  const action = screen.getByRole('button', { name: 'Outer action' })
  action.focus()
  const inner = render(
    <Modal open title="Inner" onClose={closeInner}>
      <button>Inner action</button>
    </Modal>,
  )
  await user.keyboard('{Escape}')
  expect(closeInner).toHaveBeenCalledTimes(1)
  expect(closeOuter).not.toHaveBeenCalled()
  inner.unmount()
  expect(action).toHaveFocus()
  outer.unmount()
})
