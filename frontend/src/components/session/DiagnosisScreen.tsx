import { useTranslation } from 'react-i18next'

import { useAuth } from '../../contexts/AuthContext'
import { useCreateDiagnosis, useVideoNotes } from '../../hooks/participant'
import { clearDraft } from '../../hooks/useLocalDraft'
import type { Question } from '../../lib/questionnaire'
import { useToast } from '../Toast'
import DiagnosisView from './DiagnosisView'

interface Props {
  videoId: number
  taskDescription: string
  questions: Question[]
  onComplete: () => void
}

export default function DiagnosisScreen({
  videoId,
  taskDescription,
  questions,
  onComplete,
}: Props) {
  const { t } = useTranslation()
  const { user } = useAuth()
  const toast = useToast()
  const notes = useVideoNotes(videoId)
  const createDiagnosis = useCreateDiagnosis()

  // Keyed by participant as well as case: lab machines are shared, and one
  // participant must never be shown another's draft.
  const draftKey = `diagnosis.${user?.id ?? 'anon'}.${videoId}`

  if (notes.isLoading) return <div className="panel">{t('common.loading')}</div>

  return (
    <DiagnosisView
      taskDescription={taskDescription}
      notes={notes.data ?? []}
      draftKey={draftKey}
      questions={questions}
      submitting={createDiagnosis.isPending}
      onSubmit={async (text, timeSpentSeconds, answers) => {
        try {
          await createDiagnosis.mutateAsync({
            video_id: videoId,
            text,
            time_spent_seconds: timeSpentSeconds,
            answers,
          })
          // Only once it is safely stored.
          clearDraft(draftKey)
          onComplete()
        } catch {
          toast.show(t('session.error'), 'error')
        }
      }}
    />
  )
}
