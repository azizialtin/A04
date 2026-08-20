import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import NotesPanel from './NotesPanel'

test('saves a snapshot tagged with the video time on blur', () => {
  const onSnapshot = vi.fn()
  render(<NotesPanel getVideoTime={() => 5} onSnapshot={onSnapshot} />)

  const box = screen.getByRole('textbox')
  fireEvent.change(box, { target: { value: 'loop bound is off' } })
  fireEvent.blur(box)

  expect(onSnapshot).toHaveBeenCalledWith(5, 'loop bound is off')
})

test('comes back with the notes already saved for this case', () => {
  render(<NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} initialText="written before the reload" />)
  expect(screen.getByRole('textbox')).toHaveValue('written before the reload')
})

test('adopts saved notes that arrive after the first render', () => {
  const { rerender } = render(<NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} />)
  expect(screen.getByRole('textbox')).toHaveValue('')

  rerender(<NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} initialText="from the server" />)
  expect(screen.getByRole('textbox')).toHaveValue('from the server')
})

test('does not overwrite notes the participant is already typing', () => {
  const { rerender } = render(<NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'typed first' } })

  // The fetch resolves late; the box must keep what is being typed into it.
  rerender(<NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} initialText="from the server" />)
  expect(screen.getByRole('textbox')).toHaveValue('typed first')
})

test('does not re-save restored notes that have not changed', () => {
  const onSnapshot = vi.fn()
  render(<NotesPanel getVideoTime={() => 3} onSnapshot={onSnapshot} initialText="unchanged" />)

  fireEvent.blur(screen.getByRole('textbox'))
  expect(onSnapshot).not.toHaveBeenCalled()
})

test('logs the click into the box and how long the typing ran', () => {
  vi.useFakeTimers()
  const onFocus = vi.fn()
  const onTypingBurst = vi.fn()
  render(
    <NotesPanel
      getVideoTime={() => 2}
      onSnapshot={vi.fn()}
      onFocus={onFocus}
      onTypingBurst={onTypingBurst}
    />,
  )

  const box = screen.getByRole('textbox')
  fireEvent.focus(box)
  expect(onFocus).toHaveBeenCalledTimes(1)

  fireEvent.change(box, { target: { value: 'die' } })
  vi.advanceTimersByTime(300)
  fireEvent.change(box, { target: { value: 'die Schleife' } })
  fireEvent.blur(box)

  // One event per stretch of typing, measured from the first keystroke.
  expect(onTypingBurst).toHaveBeenCalledTimes(1)
  expect(onTypingBurst).toHaveBeenCalledWith(300, 'die Schleife'.length)
  vi.useRealTimers()
})

test('a blur with nothing typed logs nothing', () => {
  const onTypingBurst = vi.fn()
  render(<NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} onTypingBurst={onTypingBurst} />)

  fireEvent.blur(screen.getByRole('textbox'))
  expect(onTypingBurst).not.toHaveBeenCalled()
})

test('the typing duration is the same whether the pause or the blur ends it', () => {
  vi.useFakeTimers()
  const onTypingBurst = vi.fn()
  const { unmount } = render(
    <NotesPanel getVideoTime={() => 0} onSnapshot={vi.fn()} onTypingBurst={onTypingBurst} />,
  )

  // Left alone, the 800 ms debounce is what saves it — but the burst was 300 ms
  // long, and the sheet's DURATION must not carry the debounce with it.
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'die' } })
  vi.advanceTimersByTime(300)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'die Schleife' } })
  vi.advanceTimersByTime(900)

  expect(onTypingBurst).toHaveBeenCalledWith(300, 'die Schleife'.length)
  unmount()
  vi.useRealTimers()
})
