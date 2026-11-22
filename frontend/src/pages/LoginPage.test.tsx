import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { authApi } from '../api/participant'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import i18n from '../i18n'
import { reloadIfOutdated, reloadPage, type PageState } from '../lib/pageVersion'
import LoginPage from './LoginPage'

vi.mock('../lib/pageVersion', () => ({ reloadIfOutdated: vi.fn(), reloadPage: vi.fn() }))

const pageCheck = vi.mocked(reloadIfOutdated)
const KEPT_ID = 'a04.login.kept_id'
const OUTDATED =
  'Diese Seite ist nicht auf dem neuesten Stand. Bitte laden Sie sie neu, bevor Sie beginnen (Strg + F5), oder wenden Sie sich an das Studienteam.'
const RELOADED = 'Die Seite wurde auf den neuesten Stand gebracht. Bitte melden Sie sich jetzt an.'

/** The page check as the browser would answer it; a reload saves first, as the real one does. */
function pageIs(state: PageState) {
  pageCheck.mockImplementation(async (options) => {
    if (options?.signal?.aborted) return 'unknown'
    if (state === 'reloading') options?.beforeReload?.()
    return state
  })
}

/** Checks that stay unanswered until the test answers them, like a slow server. */
function pageAnswersLater() {
  const questions: {
    signal: AbortSignal
    answer: (state: PageState) => void
  }[] = []
  pageCheck.mockImplementation(
    (options) =>
      new Promise<PageState>((resolve) => {
        const signal = options!.signal!
        questions.push({
          signal,
          answer: (state) => {
            // The real check does nothing once it has been withdrawn.
            if (signal.aborted) return resolve('unknown')
            if (state === 'reloading') options?.beforeReload?.()
            resolve(state)
          },
        })
      }),
  )
  return questions
}

function renderLogin() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <LoginPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  window.sessionStorage.clear()
  pageCheck.mockReset()
  vi.mocked(reloadPage).mockReset()
  pageIs('current')
})

afterEach(async () => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  await act(async () => {
    await i18n.changeLanguage('de')
  })
})

test.each([
  [403, 'Sie haben diese Studie bereits abgeschlossen. Vielen Dank für Ihre Teilnahme!'],
  [401, 'Unbekannte Teilnehmer-ID. Bitte wenden Sie sich an das Studienteam.'],
  [429, 'Zu viele Anmeldeversuche. Bitte warten Sie eine Minute und versuchen Sie es erneut.'],
  [
    500,
    'Anmeldung momentan nicht möglich. Bitte prüfen Sie die Verbindung und versuchen Sie es erneut.',
  ],
])('explains participant login failure %s accurately', async (status, message) => {
  const spy = vi
    .spyOn(authApi, 'participantLogin')
    .mockRejectedValue({ isAxiosError: true, response: { status } })
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <LoginPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  )
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'QA-42' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  expect(await screen.findByText(message)).toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Anmelden' })).toBeEnabled()
  spy.mockRestore()
})

test('submits the entered participant id', async () => {
  const spy = vi.spyOn(authApi, 'participantLogin').mockResolvedValue({ access_token: 'a.b.c' })
  render(
    <MemoryRouter>
      <AuthProvider>
        <ToastProvider>
          <LoginPage />
        </ToastProvider>
      </AuthProvider>
    </MemoryRouter>,
  )

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'P-42' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)

  await waitFor(() => expect(spy).toHaveBeenCalledWith('P-42'))
  spy.mockRestore()
})

test('the page is checked when it opens, and an up-to-date one says nothing', async () => {
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
  expect(screen.getByRole('textbox')).toHaveValue('')
})

test('signing in on an outdated page reloads it instead and keeps the id', async () => {
  const spy = vi.spyOn(authApi, 'participantLogin').mockResolvedValue({ access_token: 'a.b.c' })
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  pageIs('reloading')

  fireEvent.change(screen.getByRole('textbox'), { target: { value: '  TN-042 ' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)

  await waitFor(() => expect(pageCheck).toHaveBeenCalledTimes(2))
  // Three seconds at most: a slow server does not keep the participant waiting.
  expect(pageCheck.mock.calls[1][0]).toMatchObject({ timeoutMs: 3000 })
  expect(JSON.parse(window.sessionStorage.getItem(KEPT_ID)!)).toEqual({
    id: 'TN-042',
    submitted: true,
  })
  // No session starts on the old page, and the button cannot be pressed again.
  await act(async () => {})
  expect(spy).not.toHaveBeenCalled()
  expect(screen.getByRole('button', { name: 'Wird geladen…' })).toBeDisabled()
})

test('after that reload the id is back in the field and the page says what happened', async () => {
  const spy = vi.spyOn(authApi, 'participantLogin').mockResolvedValue({ access_token: 'a.b.c' })
  window.sessionStorage.setItem(KEPT_ID, JSON.stringify({ id: 'TN-042', submitted: true }))

  renderLogin()

  expect(screen.getByRole('textbox')).toHaveValue('TN-042')
  expect(await screen.findByText(RELOADED)).toBeInTheDocument()
  expect(window.sessionStorage.getItem(KEPT_ID)).toBeNull()
  // The participant presses the button; nothing signs in on its own.
  await act(async () => {})
  expect(spy).not.toHaveBeenCalled()
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(spy).toHaveBeenCalledWith('TN-042'))
})

test('a reload while the page waits keeps what was typed and says nothing', async () => {
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-0' } })
  pageIs('reloading')
  vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_000)

  fireEvent.focus(window)

  await waitFor(() =>
    expect(JSON.parse(window.sessionStorage.getItem(KEPT_ID) ?? 'null')).toEqual({
      id: 'TN-0',
      submitted: false,
    }),
  )
})

test('an id kept by a background reload comes back without a message', async () => {
  window.sessionStorage.setItem(KEPT_ID, JSON.stringify({ id: 'TN-0', submitted: false }))
  renderLogin()
  expect(screen.getByRole('textbox')).toHaveValue('TN-0')
  await waitFor(() => expect(window.sessionStorage.getItem(KEPT_ID)).toBeNull())
  expect(screen.queryByText(RELOADED)).not.toBeInTheDocument()
})

test.each(['not json', '"TN-1"', '{"id": 7}', 'null', '[]'])(
  'a kept id that is not what this page wrote (%s) is ignored',
  async (stored) => {
    window.sessionStorage.setItem(KEPT_ID, stored)
    renderLogin()
    expect(screen.getByRole('textbox')).toHaveValue('')
    await act(async () => {})
    expect(screen.queryByText(RELOADED)).not.toBeInTheDocument()
  },
)

test('when the reload did not bring the release the page says so and still signs in', async () => {
  const spy = vi.spyOn(authApi, 'participantLogin').mockResolvedValue({ access_token: 'a.b.c' })
  pageIs('outdated')
  renderLogin()

  const notice = await screen.findByRole('status')
  expect(notice).toHaveTextContent(OUTDATED)
  expect(screen.getByRole('button', { name: 'Seite neu laden' })).toHaveAttribute('type', 'button')

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-042' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(spy).toHaveBeenCalledWith('TN-042'))
})

test('the notice goes once the page has caught up, and stays while the server is silent', async () => {
  pageIs('outdated')
  renderLogin()
  expect(await screen.findByRole('status')).toBeInTheDocument()
  const now = performance.now()
  const clock = vi.spyOn(performance, 'now')

  pageIs('unknown')
  clock.mockReturnValue(now + 60_000)
  fireEvent.focus(window)
  await waitFor(() => expect(pageCheck).toHaveBeenCalledTimes(2))
  await act(async () => {})
  expect(screen.getByRole('status')).toBeInTheDocument()

  pageIs('current')
  clock.mockReturnValue(now + 120_000)
  fireEvent.focus(window)
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
})

test('a server that cannot be asked does not stop the sign-in or raise a notice', async () => {
  const spy = vi.spyOn(authApi, 'participantLogin').mockResolvedValue({ access_token: 'a.b.c' })
  pageIs('unknown')
  renderLogin()
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-042' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(spy).toHaveBeenCalledWith('TN-042'))
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('the waiting page looks again when it is returned to, not on a timer', async () => {
  vi.useFakeTimers({
    toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout', 'performance', 'Date'],
  })
  const { unmount } = renderLogin()
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(1)

  // Clicking back into the window a moment later is not worth another request.
  fireEvent.focus(window)
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(1)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_000)
  })
  fireEvent.focus(window)
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(2)

  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_000)
  })
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(3)

  // Overnight, with nobody at the machine, it asks nothing.
  await act(async () => {
    await vi.advanceTimersByTimeAsync(14 * 60 * 60_000)
  })
  expect(pageCheck).toHaveBeenCalledTimes(3)
  expect(vi.getTimerCount()).toBe(0)

  // The next morning someone comes back to the window.
  fireEvent.focus(window)
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(4)

  unmount()
  await act(async () => {
    await vi.advanceTimersByTimeAsync(11_000)
  })
  fireEvent.focus(window)
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(4)
})

test('a hidden tab does not ask until it is shown again', async () => {
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_000)
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden')
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledOnce()
  visibility.mockReturnValue('visible')
  fireEvent(document, new Event('visibilitychange'))
  await waitFor(() => expect(pageCheck).toHaveBeenCalledTimes(2))
})

test('the notice and the message after a reload are there in English too', async () => {
  await act(async () => {
    await i18n.changeLanguage('en')
  })
  pageIs('outdated')
  const stale = renderLogin()
  expect(await screen.findByRole('status')).toHaveTextContent(
    'This page is not up to date. Please reload it before you begin (Ctrl + F5), or ask the study team.',
  )
  expect(screen.getByRole('button', { name: 'Reload page' })).toBeInTheDocument()
  stale.unmount()

  window.sessionStorage.setItem(KEPT_ID, JSON.stringify({ id: 'TN-042', submitted: true }))
  pageIs('current')
  renderLogin()
  expect(
    await screen.findByText('The page was brought up to date. Please sign in now.'),
  ).toBeInTheDocument()
})

test('a check answered after the sign-in has opened a session reloads nothing and keeps no id', async () => {
  const spy = vi.spyOn(authApi, 'participantLogin').mockResolvedValue({ access_token: 'a.b.c' })
  const questions = pageAnswersLater()
  const { unmount } = renderLogin()
  await waitFor(() => expect(questions).toHaveLength(1))
  const [whenOpened] = questions

  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-042' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)

  // Pressing the button withdraws the question still waiting from when the page opened.
  await waitFor(() => expect(questions).toHaveLength(2))
  expect(whenOpened.signal.aborted).toBe(true)
  expect(questions[1].signal.aborted).toBe(false)
  await act(async () => questions[1].answer('current'))
  await waitFor(() => expect(spy).toHaveBeenCalledWith('TN-042'))
  unmount()

  // Now the server's first answer arrives, naming a newer release.
  await act(async () => whenOpened.answer('reloading'))
  expect(window.sessionStorage.getItem(KEPT_ID)).toBeNull()
  expect(questions.every((question) => question.signal.aborted || question === questions[1])).toBe(
    true,
  )
})

test('leaving the page withdraws every check that is still waiting', async () => {
  const questions = pageAnswersLater()
  const clock = vi.spyOn(performance, 'now')
  const { unmount } = renderLogin()
  await waitFor(() => expect(questions).toHaveLength(1))
  clock.mockReturnValue(performance.now() + 60_000)
  fireEvent.focus(window)
  await waitFor(() => expect(questions).toHaveLength(2))
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-9' } })

  unmount()

  expect(questions.map((question) => question.signal.aborted)).toEqual([true, true])
  await act(async () => questions.forEach((question) => question.answer('reloading')))
  expect(window.sessionStorage.getItem(KEPT_ID)).toBeNull()
})

test('while a sign-in is under way the page does not ask in the background', async () => {
  let finish: (value: { access_token: string }) => void = () => {}
  vi.spyOn(authApi, 'participantLogin').mockReturnValue(
    new Promise((resolve) => (finish = resolve)),
  )
  const clock = vi.spyOn(performance, 'now')
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-042' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  await waitFor(() => expect(pageCheck).toHaveBeenCalledTimes(2))

  clock.mockReturnValue(performance.now() + 60_000)
  fireEvent.focus(window)
  fireEvent(document, new Event('visibilitychange'))
  await act(async () => {})
  expect(pageCheck).toHaveBeenCalledTimes(2)
  await act(async () => finish({ access_token: 'a.b.c' }))
})

test('after a refused sign-in the page asks again when it is returned to', async () => {
  vi.spyOn(authApi, 'participantLogin').mockRejectedValue({
    isAxiosError: true,
    response: { status: 401 },
  })
  const clock = vi.spyOn(performance, 'now')
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-000' } })
  fireEvent.submit(screen.getByRole('textbox').closest('form')!)
  expect(await screen.findByText(/Unbekannte Teilnehmer-ID/)).toBeInTheDocument()
  expect(pageCheck).toHaveBeenCalledTimes(2)

  clock.mockReturnValue(performance.now() + 60_000)
  fireEvent.focus(window)
  await waitFor(() => expect(pageCheck).toHaveBeenCalledTimes(3))
})

test('a reload that did not bring the release is not announced as a success', async () => {
  window.sessionStorage.setItem(KEPT_ID, JSON.stringify({ id: 'TN-042', submitted: true }))
  pageIs('outdated')
  renderLogin()

  expect(await screen.findByRole('status')).toHaveTextContent(OUTDATED)
  expect(screen.getByRole('textbox')).toHaveValue('TN-042')
  await act(async () => {})
  // One instruction on the page, not two that contradict each other.
  expect(screen.queryByText(RELOADED)).not.toBeInTheDocument()

  // Catching up later is not announced either: nobody is waiting for it any more.
  pageIs('current')
  vi.spyOn(performance, 'now').mockReturnValue(performance.now() + 60_000)
  fireEvent.focus(window)
  await waitFor(() => expect(screen.queryByRole('status')).not.toBeInTheDocument())
  expect(screen.queryByText(RELOADED)).not.toBeInTheDocument()
})

test('with a silent server the reload is not announced, and the id is still there', async () => {
  window.sessionStorage.setItem(KEPT_ID, JSON.stringify({ id: 'TN-042', submitted: true }))
  pageIs('unknown')
  renderLogin()
  await waitFor(() => expect(pageCheck).toHaveBeenCalledOnce())
  await act(async () => {})
  expect(screen.getByRole('textbox')).toHaveValue('TN-042')
  expect(screen.queryByText(RELOADED)).not.toBeInTheDocument()
  expect(screen.queryByRole('status')).not.toBeInTheDocument()
})

test('the reload button on the notice keeps what was typed', async () => {
  pageIs('outdated')
  renderLogin()
  await screen.findByRole('status')
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'TN-042' } })

  fireEvent.click(screen.getByRole('button', { name: 'Seite neu laden' }))

  expect(reloadPage).toHaveBeenCalledOnce()
  expect(JSON.parse(window.sessionStorage.getItem(KEPT_ID)!)).toEqual({
    id: 'TN-042',
    submitted: false,
  })
})
