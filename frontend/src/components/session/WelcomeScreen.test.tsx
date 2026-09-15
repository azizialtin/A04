import { fireEvent, render, screen } from '@testing-library/react'
import { vi } from 'vitest'

import WelcomeScreen from './WelcomeScreen'

test('shows the participant id and continues', () => {
  const onContinue = vi.fn()
  render(<WelcomeScreen participantId="TN-9" onContinue={onContinue} />)
  expect(screen.getByText('TN-9')).toBeInTheDocument()
  fireEvent.click(screen.getByRole('button'))
  expect(onContinue).toHaveBeenCalledTimes(1)
})

test('says what the sitting consists of before it starts', () => {
  render(<WelcomeScreen participantId="TN-9" onContinue={vi.fn()} />)

  const steps = screen.getAllByRole('listitem')
  expect(steps).toHaveLength(4)
  expect(steps.map((li) => li.textContent).join(' ')).toMatch(/SoSciSurvey/)
})

test('drops the calibration line when calibration is handled outside the app', () => {
  render(<WelcomeScreen participantId="TN-9" onContinue={vi.fn()} showCalibration={false} />)
  expect(screen.getAllByRole('listitem')).toHaveLength(3)
})

test("uses the study's own wording where it has any, and the default elsewhere", () => {
  render(
    <WelcomeScreen
      participantId="TN-9"
      onContinue={vi.fn()}
      texts={{
        welcome_title: 'Herzlich willkommen',
        welcome_intro: 'Erster Absatz.\n\nZweiter Absatz.',
        welcome_steps: ['Fragen', 'Neun Fälle'],
        welcome_note: '',
      }}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Herzlich willkommen' })).toBeInTheDocument()
  expect(screen.getByText('Erster Absatz.')).toBeInTheDocument()
  expect(screen.getByText('Zweiter Absatz.')).toBeInTheDocument()
  expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual([
    'Fragen',
    'Neun Fälle',
  ])
  // Nothing written for the note, so the built-in one stays.
  expect(screen.getByText(/Bitte merken Sie sich diese ID/)).toBeInTheDocument()
})
