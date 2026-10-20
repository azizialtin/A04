import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

import { adminApi, type Researcher } from '../../api/admin'
import { ToastProvider } from '../Toast'
import ResearchersSection from './ResearchersSection'

vi.mock('../../api/admin', async () => {
  const actual = await vi.importActual<typeof import('../../api/admin')>('../../api/admin')
  return {
    ...actual,
    adminApi: {
      ...actual.adminApi,
      listResearchers: vi.fn(),
      createResearcher: vi.fn(),
      resetResearcherPassword: vi.fn(),
      revokeResearcherSessions: vi.fn(),
      changeMyPassword: vi.fn(),
    },
  }
})

const listResearchers = vi.mocked(adminApi.listResearchers)
const createResearcher = vi.mocked(adminApi.createResearcher)
const resetResearcherPassword = vi.mocked(adminApi.resetResearcherPassword)
const revokeResearcherSessions = vi.mocked(adminApi.revokeResearcherSessions)
const changeMyPassword = vi.mocked(adminApi.changeMyPassword)

const ME: Researcher = { id: 1, email: 'me@uni.example', name: 'Ich', created_at: '2026-08-26' }
const OTHER: Researcher = { id: 2, email: 'other@uni.example', name: '', created_at: null }

function view(onNewToken = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ResearchersSection me="me@uni.example" onNewToken={onNewToken} />
      </ToastProvider>
    </QueryClientProvider>,
  )
  return onNewToken
}

beforeEach(() => {
  listResearchers.mockReset().mockResolvedValue([ME, OTHER])
  createResearcher.mockReset()
  resetResearcherPassword.mockReset().mockResolvedValue(OTHER)
  revokeResearcherSessions.mockReset().mockResolvedValue(OTHER)
  changeMyPassword.mockReset().mockResolvedValue('new-token')
})

const row = (email: string) => within(screen.getByText(email).closest('tr') as HTMLElement)

test('lists the accounts, with the own row offering a password change and the others a reset', async () => {
  view()
  await screen.findByText('other@uni.example')
  expect(row('me@uni.example').getByText('(Sie)')).toBeInTheDocument()
  expect(
    row('me@uni.example').getByRole('button', { name: 'Eigenes Passwort ändern' }),
  ).toBeEnabled()
  expect(
    row('other@uni.example').getByRole('button', { name: 'Passwort zurücksetzen' }),
  ).toBeEnabled()
  expect(row('other@uni.example').getByRole('button', { name: 'Sitzungen beenden' })).toBeEnabled()
  expect(row('me@uni.example').queryByRole('button', { name: 'Sitzungen beenden' })).toBeNull()
})

test('a new account needs an address and a long enough password, then shows the password once', async () => {
  createResearcher.mockResolvedValue({ ...OTHER, id: 3, email: 'neu@uni.example', name: 'Neu' })
  view()
  await screen.findByText('other@uni.example')

  fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: ' Neu@uni.example ' } })
  fireEvent.change(screen.getByLabelText(/^Passwort/), { target: { value: 'short' } })
  fireEvent.click(screen.getByRole('button', { name: 'Zugang anlegen' }))
  expect(screen.getByText('Passwort: Mindestens 12 Zeichen.')).toBeInTheDocument()
  expect(createResearcher).not.toHaveBeenCalled()

  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Neu' } })
  fireEvent.click(screen.getByRole('button', { name: 'Vorschlag' }))
  const suggested = (screen.getByLabelText(/^Passwort/) as HTMLInputElement).value
  expect(suggested).toHaveLength(16)
  fireEvent.click(screen.getByRole('button', { name: 'Zugang anlegen' }))

  await waitFor(() =>
    expect(createResearcher).toHaveBeenCalledWith({
      email: 'Neu@uni.example',
      name: 'Neu',
      password: suggested,
    }),
  )
  const handover = await screen.findByRole('status')
  expect(handover).toHaveTextContent('neu@uni.example')
  expect(handover).toHaveTextContent(suggested)
  // The form is empty again, ready for the next one.
  expect((screen.getByLabelText('E-Mail') as HTMLInputElement).value).toBe('')
})

test('an address that already has an account is said so', async () => {
  createResearcher.mockRejectedValue({ response: { status: 409 } })
  view()
  await screen.findByText('other@uni.example')
  fireEvent.change(screen.getByLabelText('E-Mail'), { target: { value: 'other@uni.example' } })
  fireEvent.change(screen.getByLabelText(/^Passwort/), {
    target: { value: 'long-enough-password' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Zugang anlegen' }))
  await screen.findByText('Für diese E-Mail-Adresse gibt es schon einen Zugang.')
})

test('resetting a password sets it on the server and shows it once', async () => {
  view()
  await screen.findByText('other@uni.example')
  fireEvent.click(row('other@uni.example').getByRole('button', { name: 'Passwort zurücksetzen' }))
  const dialog = screen.getByRole('dialog', { name: 'Passwort zurücksetzen' })

  fireEvent.click(within(dialog).getByRole('button', { name: 'Passwort setzen' }))
  expect(within(dialog).getByText('Mindestens 12 Zeichen.')).toBeInTheDocument()
  expect(resetResearcherPassword).not.toHaveBeenCalled()

  fireEvent.change(within(dialog).getByLabelText(/^Passwort/), {
    target: { value: 'handed-over-in-person' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Passwort setzen' }))
  await waitFor(() =>
    expect(resetResearcherPassword).toHaveBeenCalledWith(2, 'handed-over-in-person'),
  )
  expect(await within(dialog).findByRole('status')).toHaveTextContent('handed-over-in-person')
})

test('ending sessions asks first', async () => {
  const confirm = vi.spyOn(window, 'confirm')
  view()
  await screen.findByText('other@uni.example')

  confirm.mockReturnValue(false)
  fireEvent.click(row('other@uni.example').getByRole('button', { name: 'Sitzungen beenden' }))
  expect(revokeResearcherSessions).not.toHaveBeenCalled()

  confirm.mockReturnValue(true)
  fireEvent.click(row('other@uni.example').getByRole('button', { name: 'Sitzungen beenden' }))
  await waitFor(() => expect(revokeResearcherSessions).toHaveBeenCalledWith(2))
  expect(confirm.mock.calls[0][0]).toContain('other@uni.example')
  confirm.mockRestore()
})

test('changing the own password hands the new session token back', async () => {
  const onNewToken = view()
  await screen.findByText('other@uni.example')
  fireEvent.click(screen.getByRole('button', { name: 'Eigenes Passwort ändern' }))
  const dialog = screen.getByRole('dialog', { name: 'Eigenes Passwort ändern' })

  fireEvent.change(within(dialog).getByLabelText('Aktuelles Passwort'), {
    target: { value: 'old-password-1234' },
  })
  fireEvent.change(within(dialog).getByLabelText(/^Neues Passwort \(/), {
    target: { value: 'new-password-5678' },
  })
  fireEvent.change(within(dialog).getByLabelText('Neues Passwort wiederholen'), {
    target: { value: 'new-password-56' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Passwort ändern' }))
  expect(within(dialog).getByText('Die Wiederholung stimmt nicht überein.')).toBeInTheDocument()
  expect(changeMyPassword).not.toHaveBeenCalled()

  fireEvent.change(within(dialog).getByLabelText('Neues Passwort wiederholen'), {
    target: { value: 'new-password-5678' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Passwort ändern' }))
  await waitFor(() =>
    expect(changeMyPassword).toHaveBeenCalledWith('old-password-1234', 'new-password-5678'),
  )
  await waitFor(() => expect(onNewToken).toHaveBeenCalledWith('new-token'))
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
})

test('a wrong current password is named as such', async () => {
  changeMyPassword.mockRejectedValue({ response: { status: 400 } })
  view()
  await screen.findByText('other@uni.example')
  fireEvent.click(screen.getByRole('button', { name: 'Eigenes Passwort ändern' }))
  const dialog = screen.getByRole('dialog', { name: 'Eigenes Passwort ändern' })
  fireEvent.change(within(dialog).getByLabelText('Aktuelles Passwort'), { target: { value: 'x' } })
  fireEvent.change(within(dialog).getByLabelText(/^Neues Passwort \(/), {
    target: { value: 'new-password-5678' },
  })
  fireEvent.change(within(dialog).getByLabelText('Neues Passwort wiederholen'), {
    target: { value: 'new-password-5678' },
  })
  fireEvent.click(within(dialog).getByRole('button', { name: 'Passwort ändern' }))
  await within(dialog).findByText('Das aktuelle Passwort stimmt nicht.')
})
