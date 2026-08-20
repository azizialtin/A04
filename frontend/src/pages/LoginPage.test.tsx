import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { vi } from 'vitest'

import { authApi } from '../api/participant'
import { ToastProvider } from '../components/Toast'
import { AuthProvider } from '../contexts/AuthContext'
import LoginPage from './LoginPage'

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
