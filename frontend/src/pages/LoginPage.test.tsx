import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { authApi } from '../api/participant'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import LoginPage from './LoginPage'

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
