import { render, screen } from '@testing-library/react'

import App from './App'

beforeEach(() => localStorage.clear())

test('unauthenticated visitors land on the login page', () => {
  render(<App />)
  // The participant-id field is the login page's only textbox.
  expect(screen.getByRole('textbox')).toBeInTheDocument()
})
