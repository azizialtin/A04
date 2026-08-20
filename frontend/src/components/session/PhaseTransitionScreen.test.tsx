import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import PhaseTransitionScreen from './PhaseTransitionScreen'

test('shows the neutral phase label and continues', () => {
  const onContinue = vi.fn()
  render(<PhaseTransitionScreen phaseNumber={2} onContinue={onContinue} />)
  expect(screen.getByText('Phase 2')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button'))
  expect(onContinue).toHaveBeenCalledTimes(1)
})
