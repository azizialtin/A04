import { fireEvent, render, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'

import type { Question } from '../../lib/questionnaire'
import CaseOutroScreen from './CaseOutroScreen'

const questions: Question[] = [
  { id: 'auth1', type: 'likert', text: 'Authentisch?', scale_min: 1, scale_max: 6 },
]

test('closes the case and asks its questions on one screen', () => {
  const onSubmit = vi.fn()
  render(
    <CaseOutroScreen
      instruction="Bitte beurteilen Sie die folgenden Aussagen."
      questions={questions}
      onSubmit={onSubmit}
    />,
  )

  expect(screen.getByRole('heading', { name: 'Fall abgeschlossen' })).toBeInTheDocument()
  expect(screen.getByText('Bitte beurteilen Sie die folgenden Aussagen.')).toBeInTheDocument()

  const submit = screen.getByRole('button')
  expect(submit).toBeDisabled()

  fireEvent.click(screen.getByRole('radio', { name: '6' }))
  fireEvent.click(submit)
  expect(onSubmit).toHaveBeenCalledWith({ auth1: 6 }, expect.any(Number))
})

test('a study with no outro battery still gets a way onwards', () => {
  const onSubmit = vi.fn()
  render(<CaseOutroScreen instruction="" questions={[]} onSubmit={onSubmit} />)

  fireEvent.click(screen.getByRole('button'))
  expect(onSubmit).toHaveBeenCalledWith({}, expect.any(Number))
})

test('a study can rename the closing screen and rewrite its text', () => {
  render(
    <CaseOutroScreen
      instruction=""
      questions={[]}
      heading="Geschafft"
      body={'Kurz durchatmen.\n\nGleich geht es weiter.'}
      onSubmit={vi.fn()}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Geschafft' })).toBeInTheDocument()
  expect(screen.getByText('Gleich geht es weiter.')).toBeInTheDocument()
  expect(screen.queryByText('Fall abgeschlossen')).toBeNull()
})
