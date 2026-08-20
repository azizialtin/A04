import { fireEvent, render, screen } from '@testing-library/react'
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
