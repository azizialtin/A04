import { useTranslation } from 'react-i18next'

import { useElapsedSeconds } from '../../hooks/useElapsedSeconds'
import type { Answers, Question } from '../../lib/questionnaire'
import QuestionnaireRenderer from './QuestionnaireRenderer'

interface Props {
  instruction: string
  questions: Question[]
  submitting?: boolean
  onSubmit: (answers: Answers, timeSpentSeconds: number) => void
}

/**
 * Closes a case: a line to say it is over, then the short battery about effort
 * and authenticity. One screen and one submission — the questions belong to the
 * case just ended, not to a page of their own.
 */
export default function CaseOutroScreen({ instruction, questions, submitting, onSubmit }: Props) {
  const { t } = useTranslation()
  const elapsed = useElapsedSeconds()

  if (questions.length === 0) {
    return (
      <div className="panel">
        <h2>{t('case_outro.title')}</h2>
        <p className="lead">{t('case_outro.body_plain')}</p>
        <div className="panel__actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={submitting}
            onClick={() => onSubmit({}, elapsed())}
          >
            {t('common.continue')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <QuestionnaireRenderer
      title={t('case_outro.title')}
      description={t('case_outro.body')}
      instruction={instruction}
      questions={questions}
      submitting={submitting}
      onSubmit={onSubmit}
    />
  )
}
