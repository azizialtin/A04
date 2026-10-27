import { useTranslation } from 'react-i18next'

import { useElapsedSeconds } from '../../hooks/useElapsedSeconds'
import type { Answers, Question } from '../../lib/questionnaire'
import QuestionnaireRenderer from './QuestionnaireRenderer'
import StudyText from '../StudyText'
import './CaseOutroScreen.css'

interface Props {
  instruction: string
  questions: Question[]
  submitting?: boolean
  initialAnswers?: Answers
  /** The study's own heading and text, when it wrote any. */
  heading?: string
  body?: string
  onSubmit: (answers: Answers, timeSpentSeconds: number) => void
}

/**
 * Closes a case: a line to say it is over, then the short battery about effort
 * and authenticity. One screen and one submission — the questions belong to the
 * case just ended, not to a page of their own.
 */
export default function CaseOutroScreen({
  instruction,
  questions,
  submitting,
  initialAnswers,
  heading,
  body,
  onSubmit,
}: Props) {
  const { t } = useTranslation()
  const elapsed = useElapsedSeconds()

  if (questions.length === 0) {
    return (
      <div className="panel">
        <h2>{heading || t('case_outro.title')}</h2>
        {body ? (
          <StudyText text={body} className="lead" />
        ) : (
          <p className="lead">{t('case_outro.body_plain')}</p>
        )}
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
    <div className="case-outro">
      <QuestionnaireRenderer
        title={heading || t('case_outro.title')}
        description={body || t('case_outro.body')}
        instruction={instruction}
        questions={questions}
        submitting={submitting}
        initialAnswers={initialAnswers}
        onSubmit={onSubmit}
      />
    </div>
  )
}
