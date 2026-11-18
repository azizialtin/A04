import { act, fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect, useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import CaseVideoScreen from './CaseVideoScreen'
import { enqueue } from '../../lib/outbox'

const capture = vi.hoisted(() => ({ start: vi.fn(), stop: vi.fn(), disconnect: vi.fn() }))
vi.mock('../../hooks/participant', () => ({ useVideoNotes: () => ({ data: [] }) }))
vi.mock('../../api/participant', () => ({
  participantApi: { getVideoUrl: async () => ({ signed_url: 'https://cdn.test/case.mp4' }) },
}))
vi.mock('../../hooks/useScreenRecording', () => ({
  useScreenRecording: () => {
    useEffect(() => {
      capture.start()
      return () => capture.stop()
    }, [])
  },
}))
vi.mock('../../lib/stimulusAudio', async (original) => ({
  ...(await original<typeof import('../../lib/stimulusAudio')>()),
  connectStimulusAudio: () => capture.disconnect,
  prepareStimulusAudio: vi.fn(),
  failStimulusAudio: vi.fn(),
  resetStimulusAudioSource: vi.fn(),
}))
vi.mock('../../lib/outbox', () => ({ enqueue: vi.fn() }))

const props = {
  videoId: 7,
  infoText: 'Information',
  studentTaskText: 'Aufgabe',
  timeLimitSeconds: null,
}

function deferred() {
  let resolve!: () => void
  let reject!: (error: Error) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

async function media() {
  const video = (await screen.findByLabelText('Fallvideo')) as HTMLVideoElement
  Object.defineProperty(video, 'duration', { value: 120, configurable: true })
  fireEvent.loadedMetadata(video)
  return video
}

test('instructions are shown only in their popup, with separate text and close AOIs', async () => {
  const user = userEvent.setup()
  render(<CaseVideoScreen {...props} onComplete={vi.fn()} />)
  await media()
  expect(screen.queryByText(/Sie sehen hier ein Video/)).not.toBeInTheDocument()
  const button = screen.getByRole('button', { name: 'Aufgabenstellung' })
  expect(button).toHaveAttribute('data-aoi', 'task_button')
  await user.click(button)
  const dialog = screen.getByRole('dialog', { name: 'Aufgabenstellung' })
  expect(dialog).toHaveAttribute('data-aoi-modal', 'task_dialog')
  expect(dialog.querySelector('[data-aoi="task_dialog_text"]')).toHaveTextContent(
    'Sie sehen hier ein Video einer Unterrichtssituation. Sie können sich während des Videos Notizen machen und so oft wie Sie möchten vor und zurück springen oder sich einzelne Abschnitte sowie das ganze Video nochmal ansehen. Ihre Bearbeitungsaufgabe beinhaltet das Schreiben einer Diagnose zur Situation.',
  )
  expect(within(dialog).getByRole('button', { name: 'Schließen' })).toHaveAttribute(
    'data-aoi',
    'task_dialog_close',
  )
  await user.keyboard('{Escape}')
  expect(screen.queryByText(/Sie sehen hier ein Video/)).not.toBeInTheDocument()
  expect(button).toHaveFocus()
  expect(capture.start).toHaveBeenCalledOnce()
  expect(capture.stop).not.toHaveBeenCalled()
})

test.each([
  ['Aufgabenstellung', 'task'],
  ['Diagnose Definition', 'info'],
  ['Schüler-Aufgabe und gegebener Code', 'student_task'],
])('%s logs one exposure per open, including a screen exit', async (buttonLabel, eventPrefix) => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  const { unmount } = render(<CaseVideoScreen {...props} onComplete={vi.fn()} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: buttonLabel }))
  const dialog = screen.getByRole('dialog')
  expect(dialog.querySelector(`[data-aoi="${eventPrefix}_dialog_text"]`)).toHaveAttribute(
    'data-aoi-priority',
    '1',
  )
  await act(async () => vi.advanceTimersByTime(2500))
  fireEvent.click(within(dialog).getByRole('button', { name: 'Schließen' }))
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: `${eventPrefix}_closed`,
      payload: { currentTime: 0, durationMs: 2500, reason: 'dismissed' },
    }),
  )
  fireEvent.click(screen.getByRole('button', { name: buttonLabel }))
  await act(async () => vi.advanceTimersByTime(1500))
  unmount()
  const events = vi.mocked(enqueue).mock.calls.map(([, body]) => body)
  expect(events.filter((body) => body.event_type === `${eventPrefix}_opened`)).toHaveLength(2)
  expect(events.filter((body) => body.event_type === `${eventPrefix}_closed`)).toHaveLength(2)
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: `${eventPrefix}_closed`,
      payload: { currentTime: 0, durationMs: 1500, reason: 'screen_exit' },
    }),
  )
})

test('the student-task popup renders supplied JSON code as numbered and highlighted Java', async () => {
  const source = ['public class Heizung {', '', '    private int temperatur;', '}']
  render(
    <CaseVideoScreen
      {...props}
      studentTaskText={`Schüler-Aufgabe und gegebener Code\n\nGegebener Code (JSON-Format):\n\nCodeblock 1:\n${JSON.stringify(source, null, 2)}`}
      onComplete={vi.fn()}
    />,
  )
  await media()
  fireEvent.click(screen.getByRole('button', { name: 'Schüler-Aufgabe und gegebener Code' }))
  const dialog = screen.getByRole('dialog', { name: 'Aufgabe der Schüler:innen' })
  expect(dialog.querySelectorAll('pre.code')).toHaveLength(1)
  const rows = Array.from(dialog.querySelectorAll('.code__line'))
  expect(rows.map((line) => line.textContent)).toEqual(source.map((line) => line + '\n'))
  expect(rows.map((line) => line.getAttribute('data-line'))).toEqual(['1', '2', '3', '4'])
  expect(dialog.querySelector('.tok--kw')).toHaveTextContent('public')
  expect(dialog.textContent).not.toContain('JSON-Format')
})

test('a normal page exit closes popup exposure once even without a React unmount', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  const { unmount } = render(<CaseVideoScreen {...props} onComplete={vi.fn()} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Aufgabenstellung' }))
  await act(async () => vi.advanceTimersByTime(1200))
  fireEvent(window, new PageTransitionEvent('pagehide', { persisted: false }))
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: 'task_closed',
      payload: { currentTime: 0, durationMs: 1200, reason: 'page_exit' },
    }),
  )
  unmount()
  expect(
    vi.mocked(enqueue).mock.calls.filter(([, body]) => body.event_type === 'task_closed'),
  ).toHaveLength(1)
})

test('every Continue asks before leaving; cancellation keeps notes, player and capture intact', async () => {
  const user = userEvent.setup()
  const onComplete = vi.fn()
  render(<CaseVideoScreen {...props} onComplete={onComplete} />)
  const video = await media()
  video.currentTime = 15
  video.volume = 0.4
  Object.defineProperty(video, 'paused', { value: false, configurable: true })
  fireEvent.play(video)
  fireEvent.timeUpdate(video)
  await user.type(screen.getByRole('textbox', { name: 'Notizen' }), 'Meine Notiz')
  const next = screen.getByRole('button', { name: 'Weiter' })
  await user.click(next)

  const dialog = screen.getByRole('dialog', { name: 'Fall abschließen?' })
  expect(dialog).toHaveAttribute('data-aoi-modal', 'case_exit_dialog')
  expect(screen.getByRole('button', { name: 'Beim Fall bleiben' })).toHaveFocus()
  expect(onComplete).not.toHaveBeenCalled()
  expect(enqueue).toHaveBeenCalledWith(
    'note',
    expect.objectContaining({ video_id: 7, video_time_seconds: 15, text: 'Meine Notiz' }),
  )
  // The media clock can continue while the dialog is visible; no implicit pause
  // or seek, recorder teardown, or replacement audio graph may be introduced.
  video.currentTime = 18
  fireEvent.timeUpdate(video)
  await user.click(within(dialog).getByRole('button', { name: 'Beim Fall bleiben' }))
  expect(next).toHaveFocus()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(screen.getByLabelText('Fallvideo')).toBe(video)
  expect(video.currentTime).toBe(18)
  expect(video.volume).toBe(0.4)
  expect(video.paused).toBe(false)
  expect(HTMLMediaElement.prototype.pause).not.toHaveBeenCalled()
  expect(HTMLMediaElement.prototype.play).not.toHaveBeenCalled()
  expect(screen.getByRole('textbox', { name: 'Notizen' })).toHaveValue('Meine Notiz')
  expect(capture.start).toHaveBeenCalledOnce()
  expect(capture.stop).not.toHaveBeenCalled()
  expect(capture.disconnect).not.toHaveBeenCalled()
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: 'case_exit_opened',
      video_id: 7,
      client_ts: expect.any(Number),
      payload: { currentTime: 15 },
    }),
  )
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({ event_type: 'case_exit_cancelled', payload: { currentTime: 18 } }),
  )

  // Finishing the clip does not bypass the confirmation either.
  fireEvent.ended(video)
  await user.click(next)
  expect(screen.getByRole('dialog', { name: 'Fall abschließen?' })).toBeInTheDocument()
  expect(onComplete).not.toHaveBeenCalled()
})

test('keyboard opening defaults to staying; Escape restores focus and Tab reaches confirmation', async () => {
  const user = userEvent.setup()
  const onComplete = vi.fn()
  render(<CaseVideoScreen {...props} onComplete={onComplete} />)
  await media()
  const next = screen.getByRole('button', { name: 'Weiter' })
  next.focus()
  await user.keyboard('{Enter}')
  expect(screen.getByRole('button', { name: 'Beim Fall bleiben' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  expect(onComplete).not.toHaveBeenCalled()
  expect(next).toHaveFocus()
  await user.keyboard('{Enter}{Escape}')
  expect(next).toHaveFocus()
  await user.keyboard('{Enter}')
  await user.tab()
  expect(screen.getByRole('button', { name: 'Zur Diagnose' })).toHaveFocus()
  await user.keyboard('{Enter}')
  expect(onComplete).toHaveBeenCalledOnce()
})

test('confirmation locks duplicate requests and dismissal until navigation unmounts capture', async () => {
  const user = userEvent.setup()
  const request = deferred()
  const onComplete = vi.fn(() => request.promise)
  function Run() {
    const [done, setDone] = useState(false)
    return done ? (
      <p>Diagnose</p>
    ) : (
      <CaseVideoScreen
        {...props}
        onComplete={async () => {
          await onComplete()
          setDone(true)
        }}
      />
    )
  }
  render(<Run />)
  const video = await media()
  await user.click(screen.getByRole('button', { name: 'Weiter' }))
  await user.dblClick(screen.getByRole('button', { name: 'Zur Diagnose' }))
  expect(onComplete).toHaveBeenCalledOnce()
  expect(screen.getByRole('button', { name: 'Beim Fall bleiben' })).toBeDisabled()
  expect(screen.getByRole('button', { name: 'Schließen' })).toBeDisabled()
  await user.keyboard('{Escape}')
  fireEvent.click(screen.getByRole('dialog'))
  expect(screen.getByRole('dialog')).toBeInTheDocument()
  expect(screen.getByLabelText('Fallvideo')).toBe(video)
  expect(capture.stop).not.toHaveBeenCalled()
  expect(capture.disconnect).not.toHaveBeenCalled()
  await act(async () => request.resolve())
  expect(screen.getByText('Diagnose')).toBeInTheDocument()
  expect(capture.stop).toHaveBeenCalledOnce()
  expect(capture.disconnect).toHaveBeenCalledOnce()
  expect(
    vi.mocked(enqueue).mock.calls.filter(([, body]) => body.event_type === 'case_exit_confirmed'),
  ).toHaveLength(1)
})

test.each(['rejection', 'throw'] as const)(
  'failed navigation (%s) keeps the case and allows cancellation then retry',
  async (failure) => {
    const user = userEvent.setup()
    let attempts = 0
    const onComplete = vi.fn(() => {
      if (++attempts > 1) return Promise.resolve()
      if (failure === 'throw') throw new Error('offline')
      return Promise.reject(new Error('offline'))
    })
    render(<CaseVideoScreen {...props} onComplete={onComplete} />)
    const video = await media()
    await user.type(screen.getByRole('textbox', { name: 'Notizen' }), 'Bleibt erhalten')
    await user.click(screen.getByRole('button', { name: 'Weiter' }))
    await user.click(screen.getByRole('button', { name: 'Zur Diagnose' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('fehlgeschlagen')
    expect(capture.stop).not.toHaveBeenCalled()
    await user.click(screen.getByRole('button', { name: 'Beim Fall bleiben' }))
    expect(screen.getByLabelText('Fallvideo')).toBe(video)
    expect(screen.getByRole('textbox', { name: 'Notizen' })).toHaveValue('Bleibt erhalten')
    await user.click(screen.getByRole('button', { name: 'Weiter' }))
    await user.click(screen.getByRole('button', { name: 'Zur Diagnose' }))
    expect(onComplete).toHaveBeenCalledTimes(2)
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Weiter' })).toBeDisabled()
  },
)

test.each(['confirm', 'timer'] as const)(
  '%s arriving first wins the confirmation/expiry race without resetting the timer',
  async (first) => {
    vi.useFakeTimers({
      toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
    })
    const request = deferred()
    const onComplete = vi.fn(() => request.promise)
    render(<CaseVideoScreen {...props} timeLimitSeconds={1} onComplete={onComplete} />)
    await act(async () => {})
    fireEvent.click(screen.getByRole('button', { name: 'Weiter' }))
    const confirm = screen.getByRole('button', { name: 'Zur Diagnose' })
    if (first === 'confirm') fireEvent.click(confirm)
    await act(async () => vi.advanceTimersByTime(1000))
    fireEvent.click(confirm)
    expect(screen.getByRole('timer')).toHaveTextContent('00:00')
    expect(onComplete).toHaveBeenCalledOnce()
    expect(capture.stop).not.toHaveBeenCalled()
    await act(async () => request.resolve())
    // Success stays locked even if the parent has not rerendered yet.
    fireEvent.click(confirm)
    expect(onComplete).toHaveBeenCalledOnce()
  },
)

test('timer expiry still advances without a click; a failed request is visible and retryable', async () => {
  vi.useFakeTimers({
    toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
  })
  const request = deferred()
  const onComplete = vi.fn(() => request.promise)
  render(<CaseVideoScreen {...props} timeLimitSeconds={1} onComplete={onComplete} />)
  await act(async () => {})
  fireEvent.click(screen.getByRole('button', { name: 'Schüler-Aufgabe und gegebener Code' }))
  expect(screen.getByRole('dialog', { name: 'Aufgabe der Schüler:innen' })).toBeInTheDocument()
  await act(async () => vi.advanceTimersByTime(1000))
  expect(onComplete).toHaveBeenCalledOnce()
  expect(screen.queryByRole('dialog', { name: 'Fall abschließen?' })).not.toBeInTheDocument()
  await act(async () => request.reject(new Error('offline')))
  expect(screen.getByRole('dialog', { name: 'Fall abschließen?' })).toBeInTheDocument()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
  expect(screen.getByRole('alert')).toHaveTextContent('fehlgeschlagen')
  expect(screen.getByRole('button', { name: 'Zur Diagnose' })).toBeEnabled()
  expect(capture.stop).not.toHaveBeenCalled()
  expect(enqueue).toHaveBeenCalledWith(
    'event',
    expect.objectContaining({
      event_type: 'student_task_closed',
      payload: { currentTime: 0, durationMs: 1000, reason: 'completion_failed' },
    }),
  )
})
