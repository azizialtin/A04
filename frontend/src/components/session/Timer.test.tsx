import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import Timer from './Timer'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

const advance = (ms: number) => act(() => void vi.advanceTimersByTime(ms))

test('formats the remaining time as mm:ss', () => {
  render(<Timer seconds={104} onExpire={vi.fn()} />)
  expect(screen.getByText('01:44')).toBeInTheDocument()
})

test('counts down as the clock moves', () => {
  render(<Timer seconds={10} onExpire={vi.fn()} />)
  advance(3000)
  expect(screen.getByText('00:07')).toBeInTheDocument()
})

test('stays true to the wall clock when ticks are delayed', () => {
  // A chained one-second timer would have lost every skipped tick; reading the
  // deadline means a throttled tab comes back with the right number.
  render(<Timer seconds={120} onExpire={vi.fn()} />)
  advance(90_000)
  expect(screen.getByText('00:30')).toBeInTheDocument()
})

test('expires once, at zero', () => {
  const onExpire = vi.fn()
  render(<Timer seconds={2} onExpire={onExpire} />)

  advance(1900)
  expect(onExpire).not.toHaveBeenCalled()

  advance(200)
  expect(screen.getByText('00:00')).toBeInTheDocument()
  expect(onExpire).toHaveBeenCalledTimes(1)

  advance(5000)
  expect(onExpire).toHaveBeenCalledTimes(1)
})

test('does not fire after unmounting', () => {
  const onExpire = vi.fn()
  const { unmount } = render(<Timer seconds={2} onExpire={onExpire} />)
  unmount()
  advance(5000)
  expect(onExpire).not.toHaveBeenCalled()
})

test('restarts when the next case has a different limit', () => {
  const { rerender } = render(<Timer seconds={10} onExpire={vi.fn()} />)
  advance(5000)
  expect(screen.getByText('00:05')).toBeInTheDocument()

  rerender(<Timer seconds={60} onExpire={vi.fn()} />)
  advance(1000)
  expect(screen.getByText('00:59')).toBeInTheDocument()
})
