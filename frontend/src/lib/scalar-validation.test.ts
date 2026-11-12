import cases from '../../testdata/questionnaire-scalar-cases.json'
import { missingRequired, invalidPartialAnswers, type Question } from './questionnaire'

test.each(cases)('scalar contract %#', (testCase) => {
  const question = testCase.question as Question
  const answers = { answer: testCase.value }
  expect(missingRequired([question], answers)).toEqual(testCase.missing ? ['answer'] : [])
  expect(invalidPartialAnswers([question], answers)).toEqual(
    testCase.partial_invalid ? ['answer'] : [],
  )
  const hidden = { ...question, show_if: { question: 'absent', equals: 1 } }
  expect(missingRequired([hidden], answers)).toEqual([])
  expect(invalidPartialAnswers([hidden], answers)).toEqual([])
  expect(missingRequired([question], {})).toEqual(question.required ? ['answer'] : [])
  expect(invalidPartialAnswers([question], {})).toEqual([])
})

test.each(['number', 'slider', 'likert', 'multiple_choice'] as const)('nonfinite %s', (type) => {
  const question: Question = { id: 'answer', text: 'Validation', type, options: ['yes'] }
  for (const value of [NaN, Infinity, -Infinity]) {
    expect(missingRequired([question], { answer: value })).toEqual(['answer'])
    expect(invalidPartialAnswers([question], { answer: value })).toEqual(['answer'])
  }
})
