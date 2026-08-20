import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import SosciScreen from './SosciScreen'

test('builds the survey link with the participant id and continues', () => {
  const onContinue = vi.fn()
  render(
    <SosciScreen
      variant="pretest"
      url="https://sosci.example/x"
      idParam="id"
      participantId="TN-9"
      onContinue={onContinue}
    />,
  )
  expect(screen.getByRole('link')).toHaveAttribute('href', 'https://sosci.example/x?id=TN-9')
  fireEvent.click(screen.getByRole('button'))
  expect(onContinue).toHaveBeenCalledTimes(1)
})
