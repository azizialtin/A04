import { fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'

import DiagnosisView from './DiagnosisView'

afterEach(() => window.localStorage.clear())

test('shows the last note and gates submit on the diagnosis text', () => {
  const onSubmit = vi.fn()
  render(
    <DiagnosisView
      taskDescription="Diagnose the bug"
      draftKey="test.1"
      notes={[
        { video_time_seconds: 1, client_ts: null, text: 'early', created_at: 'x' },
        { video_time_seconds: 5, client_ts: null, text: 'final notes', created_at: 'y' },
      ]}
      onSubmit={onSubmit}
    />,
  )

  expect(screen.getByText('final notes')).toBeInTheDocument()

  const submit = screen.getByRole('button')
  expect(submit).toBeDisabled()

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'off by one' } })
  expect(submit).toBeEnabled()

  fireEvent.click(submit)
  expect(onSubmit).toHaveBeenCalledWith('off by one', expect.any(Number), {})
})

test('reports how long the diagnosis took', () => {
  vi.useFakeTimers()
  const onSubmit = vi.fn()
  render(<DiagnosisView taskDescription="" notes={[]} draftKey="test.2" onSubmit={onSubmit} />)

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'off by one' } })
  vi.advanceTimersByTime(42_000)
  fireEvent.click(screen.getByRole('button'))

  expect(onSubmit).toHaveBeenCalledWith('off by one', 42, {})
  vi.useRealTimers()
})

test('brings back an unsubmitted draft after a reload', () => {
  const first = render(
    <DiagnosisView taskDescription="" notes={[]} draftKey="test.3" onSubmit={vi.fn()} />,
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'half an answer' } })
  first.unmount()

  render(<DiagnosisView taskDescription="" notes={[]} draftKey="test.3" onSubmit={vi.fn()} />)
  expect(screen.getByRole('textbox')).toHaveValue('half an answer')
})

test('the confidence rating is part of the diagnosis, not a separate page', () => {
  const onSubmit = vi.fn()
  render(
    <DiagnosisView
      taskDescription=""
      notes={[]}
      draftKey="test.4"
      questions={[
        {
          id: 'confidence',
          type: 'slider',
          text: 'Wie sicher sind Sie sich bei Ihrer Diagnose?',
          min: 1,
          max: 5,
          labels: { min: 'unsicher', max: 'sicher' },
        },
      ]}
      onSubmit={onSubmit}
    />,
  )

  const submit = screen.getByRole('button')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'off by one' } })
  // The text alone is not the whole answer any more.
  expect(submit).toBeDisabled()

  fireEvent.change(screen.getByRole('slider'), { target: { value: '4' } })
  expect(submit).toBeEnabled()

  fireEvent.click(submit)
  expect(onSubmit).toHaveBeenCalledWith('off by one', expect.any(Number), { confidence: 4 })
})
