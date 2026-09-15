import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { expect, test } from 'vitest'

import { AUTH_STORAGE_KEY } from '../../api/client'
import { AuthProvider } from '../../contexts/AuthContext'
import ThanksScreen from './ThanksScreen'

function view(pendingWrites = 0) {
  return render(
    <MemoryRouter initialEntries={['/session']}>
      <AuthProvider>
        <Routes>
          <Route path="/session" element={<ThanksScreen pendingWrites={pendingWrites} />} />
          <Route path="/login" element={<h1>Teilnehmer-ID</h1>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  )
}

test('renders a closing heading', () => {
  view()
  expect(screen.getByRole('heading')).toBeInTheDocument()
})

test('hands the machine to the next participant', async () => {
  localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token: 'a-session' }))
  view()

  await userEvent.click(screen.getByRole('button', { name: /nächsten Person/i }))

  // Back at the id prompt, with the finished run signed out behind it.
  expect(screen.getByRole('heading', { name: 'Teilnehmer-ID' })).toBeInTheDocument()
  expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
})

test('waits while this run still has writes in flight', () => {
  view(2)

  // Logging out here would park those writes under an id nobody will sign in
  // as again, so the hand-over has to wait for the outbox.
  expect(screen.getByRole('button', { name: /nächsten Person/i })).toBeDisabled()
  expect(screen.getByText(/noch nicht alle Eingaben gespeichert/i)).toBeInTheDocument()
})
