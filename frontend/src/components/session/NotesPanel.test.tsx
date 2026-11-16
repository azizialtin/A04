import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import NotesPanel from './NotesPanel'

beforeEach(() => localStorage.clear())
afterEach(() => vi.useRealTimers())

test('saves a snapshot tagged with the video time on blur', () => {
  const onSnapshot = vi.fn()
  render(<NotesPanel getVideoTime={() => 5} onSnapshot={onSnapshot} />)

  const box = screen.getByRole('textbox')
  fireEvent.change(box, { target: { value: 'loop bound is off' } })
  fireEvent.blur(box)

  expect(onSnapshot).toHaveBeenCalledWith(5, 'loop bound is off')
})

test('comes back with the notes already saved for this case', () => {
  render(
    <NotesPanel
      getVideoTime={() => 0}
      onSnapshot={vi.fn()}
      initialText="written before the reload"
    />,
  )
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

test.each(['pagehide', 'unmount'] as const)(
  'flushes the final edit on %s before the debounce',
  (exit) => {
    vi.useFakeTimers()
    const onSnapshot = vi.fn()
    const view = render(
      <NotesPanel draftKey="notes.T-001.7" getVideoTime={() => 12} onSnapshot={onSnapshot} />,
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Last edit' } })
    expect(localStorage.getItem('a04.draft.notes.T-001.7')).toBe('Last edit')
    expect(onSnapshot).not.toHaveBeenCalled()
    if (exit === 'pagehide') window.dispatchEvent(new Event('pagehide'))
    view.unmount()
    vi.advanceTimersByTime(1000)
    expect(onSnapshot).toHaveBeenCalledOnce()
    expect(onSnapshot).toHaveBeenCalledWith(12, 'Last edit')
    expect(localStorage.getItem('a04.draft.notes.T-001.7')).toBeNull()
  },
)

test.each(['Recovered edit', ''])(
  'recovers an unqueued draft, including cleared text: %j',
  (draft) => {
    localStorage.setItem('a04.draft.notes.T-001.7', draft)
    const onSnapshot = vi.fn()
    render(
      <NotesPanel
        draftKey="notes.T-001.7"
        getVideoTime={() => 0}
        onSnapshot={onSnapshot}
        initialText="Older saved text"
      />,
    )
    expect(screen.getByRole('textbox')).toHaveValue(draft)
    expect(onSnapshot).toHaveBeenCalledOnce()
    expect(onSnapshot).toHaveBeenCalledWith(0, draft)
  },
)

test('pending flush uses the latest callbacks without resaving on every rerender', () => {
  vi.useFakeTimers()
  const first = vi.fn()
  const latest = vi.fn()
  const view = render(<NotesPanel getVideoTime={() => 1} onSnapshot={first} />)
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Pending edit' } })
  view.rerender(<NotesPanel getVideoTime={() => 8} onSnapshot={latest} />)
  expect(first).not.toHaveBeenCalled()
  expect(latest).not.toHaveBeenCalled()
  view.unmount()
  expect(latest).toHaveBeenCalledOnce()
  expect(latest).toHaveBeenCalledWith(8, 'Pending edit')
  expect(first).not.toHaveBeenCalled()
})

test('does not restore another participant or case draft', () => {
  localStorage.setItem('a04.draft.notes.OTHER.7', 'Private other note')
  localStorage.setItem('a04.draft.notes.T-001.8', 'Different case')
  render(<NotesPanel draftKey="notes.T-001.7" getVideoTime={() => 0} onSnapshot={vi.fn()} />)
  expect(screen.getByRole('textbox')).toHaveValue('')
})

test('a recovered empty draft is saved before older server notes arrive', () => {
  localStorage.setItem('a04.draft.notes.T-001.7', '')
  const onSnapshot = vi.fn()
  const view = render(
    <NotesPanel draftKey="notes.T-001.7" getVideoTime={() => 0} onSnapshot={onSnapshot} />,
  )
  expect(onSnapshot).toHaveBeenCalledWith(0, '')
  view.rerender(
    <NotesPanel
      draftKey="notes.T-001.7"
      getVideoTime={() => 0}
      onSnapshot={onSnapshot}
      initialText="Older server note"
    />,
  )
  expect(screen.getByRole('textbox')).toHaveValue('')
  expect(onSnapshot).toHaveBeenCalledOnce()
})
