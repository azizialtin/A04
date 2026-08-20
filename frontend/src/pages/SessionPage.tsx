import { Fragment, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import LanguageSwitcher from '../components/LanguageSwitcher'
import CalibrationScreen from '../components/session/CalibrationScreen'
import CaseIntroScreen from '../components/session/CaseIntroScreen'
import CaseOutroScreen from '../components/session/CaseOutroScreen'
import CaseVideoScreen from '../components/session/CaseVideoScreen'
import DiagnosisScreen from '../components/session/DiagnosisScreen'
import PhaseTransitionScreen from '../components/session/PhaseTransitionScreen'
import QuestionnaireRenderer from '../components/session/QuestionnaireRenderer'
import SosciScreen from '../components/session/SosciScreen'
import ThanksScreen from '../components/session/ThanksScreen'
import ThinkAloudScreen from '../components/session/ThinkAloudScreen'
import WelcomeScreen from '../components/session/WelcomeScreen'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import {
  useMe,
  useRespondQuestionnaire,
  useSession,
  useUpdateProgress,
} from '../hooks/participant'
import { useOutbox } from '../hooks/useOutbox'
import { enqueue } from '../lib/outbox'

// Steps that own the full viewport; everything else renders inside the shell.
const CHROMELESS = new Set([
  'welcome',
  'sosci',
  'calibration',
  'phase_transition',
  'case_video',
  'think_aloud',
  'thanks',
])

export default function SessionPage() {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const toast = useToast()
  const me = useMe()
  const session = useSession()
  const updateProgress = useUpdateProgress()
  const respond = useRespondQuestionnaire()
  const unsent = useOutbox(me.data?.id)

  if (me.isLoading || session.isLoading) {
    return <div className="fullpage">{t('session.loading')}</div>
  }
  if (me.isError || !me.data || session.isError || !session.data) {
    return <div className="fullpage is-danger">{t('session.error')}</div>
  }

  const { steps, current_step_index, total_steps } = session.data
  const step = steps[current_step_index]
  if (!step || current_step_index >= total_steps) return <ThanksScreen />

  const advance = () => updateProgress.mutate(current_step_index + 1)

  // Every battery submits the same way: store the answers, then move on. A
  // failure keeps the participant on the page with what they typed intact.
  const submitAnswers = async (
    questionnaireId: number,
    videoId: number | null,
    answers: Record<string, unknown>,
    timeSpentSeconds: number,
  ) => {
    try {
      await respond.mutateAsync({
        questionnaireId,
        video_id: videoId,
        answers,
        time_spent_seconds: timeSpentSeconds,
      })
      advance()
    } catch {
      toast.show(t('session.error'), 'error')
    }
  }

  let content: ReactNode
  switch (step.kind) {
    case 'welcome':
      content = <WelcomeScreen participantId={me.data.id} onContinue={advance} />
      break
    case 'sosci':
      content = (
        <SosciScreen
          variant={step.variant}
          url={step.url}
          idParam={step.id_param}
          participantId={step.participant_id}
          onContinue={() => {
            enqueue('event', { event_type: `sosci_${step.variant}_returned` })
            advance()
          }}
        />
      )
      break
    case 'calibration':
      content = <CalibrationScreen onComplete={advance} />
      break
    case 'phase_transition':
      content = <PhaseTransitionScreen phaseNumber={step.phase_number} onContinue={advance} />
      break
    case 'case_intro':
      content = <CaseIntroScreen onContinue={advance} />
      break
    case 'questionnaire': {
      const qStep = step
      content = (
        <QuestionnaireRenderer
          title={qStep.title}
          description={t('pre_test.page', { current: qStep.page, total: qStep.page_count })}
          instruction={qStep.description}
          questions={qStep.questions}
          submitting={respond.isPending}
          onSubmit={(answers, timeSpentSeconds) =>
            submitAnswers(qStep.questionnaire_id, null, answers, timeSpentSeconds)
          }
        />
      )
      break
    }
    case 'case_video':
      content = (
        <CaseVideoScreen
          videoId={step.video_id}
          taskDescription={step.task_description}
          infoText={step.info_text}
          studentTaskText={step.student_task_text}
          timeLimitSeconds={step.time_limit_seconds}
          onComplete={advance}
        />
      )
      break
    case 'diagnosis':
      content = (
        <DiagnosisScreen
          videoId={step.video_id}
          taskDescription={step.task_description}
          questions={step.questions}
          onComplete={advance}
        />
      )
      break
    case 'case_outro': {
      const outro = step
      content = (
        <CaseOutroScreen
          instruction={outro.instruction}
          questions={outro.questions}
          submitting={respond.isPending}
          onSubmit={(answers, timeSpentSeconds) =>
            outro.questionnaire_id === null
              ? advance()
              : submitAnswers(outro.questionnaire_id, outro.video_id, answers, timeSpentSeconds)
          }
        />
      )
      break
    }
    case 'think_aloud':
      content = <ThinkAloudScreen videoId={step.video_id} onComplete={advance} />
      break
    case 'thanks':
      content = <ThanksScreen />
      break
    default:
      content = <div className="fullpage is-danger">{t('session.error')}</div>
  }

  // Keyed by step, so React never carries one screen's state into the next. The
  // pre-test pages are adjacent steps of the same kind: without this the second
  // page opens holding the first page's answers and submits them again.
  const screen = <Fragment key={current_step_index}>{content}</Fragment>

  // Sits outside the shell: the case screen has no chrome, and that is exactly
  // where notes are written.
  const unsentBanner =
    unsent > 0 ? (
      <div className="unsent" role="status">
        {t('session.unsent', { count: unsent })}
      </div>
    ) : null

  if (CHROMELESS.has(step.kind)) {
    return (
      <>
        {screen}
        {unsentBanner}
      </>
    )
  }

  const progress = Math.round((current_step_index / total_steps) * 100)
  return (
    <div className="shell">
      {unsentBanner}
      <header className="shell__header">
        <span className="brand-sm">A04</span>
        <span className="muted">
          {t('session.progress', {
            current: Math.min(current_step_index + 1, total_steps),
            total: total_steps,
          })}
        </span>
        <div className="shell__header-right">
          <LanguageSwitcher />
          <button type="button" className="btn btn-ghost" onClick={logout}>
            {t('common.logout')}
          </button>
        </div>
      </header>
      <div className="shell__progress">
        <div style={{ width: `${progress}%` }} />
      </div>
      <main className="shell__main">{screen}</main>
    </div>
  )
}
