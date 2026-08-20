import { render, screen } from '@testing-library/react'

import ThanksScreen from './ThanksScreen'

test('renders a closing heading', () => {
  render(<ThanksScreen />)
  expect(screen.getByRole('heading')).toBeInTheDocument()
})
