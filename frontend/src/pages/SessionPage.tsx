import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'

import type { SessionStep } from '../api/participant'
import LanguageSwitcher from '../components/LanguageSwitcher'
import CalibrationScreen from '../components/session/CalibrationScreen'
import CaseIntroScreen from '../components/session/CaseIntroScreen'
import CaseOutroScreen from '../components/session/CaseOutroScreen'
import CaseVideoScreen from '../components/session/CaseVideoScreen'
import DiagnosisScreen from '../components/session/DiagnosisScreen'
import PhaseTransitionScreen from '../components/session/PhaseTransitionScreen'
import QuestionnaireRenderer from '../components/session/QuestionnaireRenderer'
import SosciScreen from '../components/session/SosciScreen'
import SessionGazeCapture from '../components/session/SessionGazeCapture'
import StepBackDialog from '../components/session/StepBackDialog'
import ThanksScreen from '../components/session/ThanksScreen'
import ThinkAloudScreen from '../components/session/ThinkAloudScreen'
import WelcomeScreen from '../components/session/WelcomeScreen'
import { useToast } from '../components/Toast'
import { useAuth } from '../contexts/AuthContext'
import {
  useMe,
  useRespondQuestionnaire,
  useSession,
  useStepBack,
  useUpdateProgress,
} from '../hooks/participant'
import { useOutbox } from '../hooks/useOutbox'
import { enqueue } from '../lib/outbox'
import { caseAt } from '../lib/sessionProgress'
import { isStepBackChord } from '../lib/stepBack'

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

// The screens with questions on them. Each logs when it appears and when its
// answers went in, on the browser's clock like every other event, so the time
// spent on a page — and on a whole section — can be read off events.csv.
const PAGE_KINDS = new Set(['questionnaire', 'diagnosis', 'case_outro'])

// The two chromeless screens a participant actually works on. They get the
// shell's progress bar laid over their top edge, so the sense of where one is
// in the study does not vanish for the longest stretches of it.
const OVERLAY_PROGRESS = new Set(['case_video', 'think_aloud'])

interface PageDescriptor {
  kind: string
  title: string
  section: string
  questionnaire_id?: number | null
  video_id?: number | null
  page?: number
  page_count?: number
}

function pageDescriptor(step: SessionStep): PageDescriptor | null {
  switch (step.kind) {
    case 'questionnaire':
      return {
        kind: step.kind,
        title: step.title,
        section: step.section,
        questionnaire_id: step.questionnaire_id,
        page: step.page,
        page_count: step.page_count,
      }
    case 'diagnosis':
      return { kind: step.kind, title: step.title, section: step.section, video_id: step.video_id }
    case 'case_outro':
      // A closing screen with no battery on it is not a page with questions.
      if (step.questionnaire_id === null) return null
      return {
        kind: step.kind,
        title: step.title,
        section: step.section,
        questionnaire_id: step.questionnaire_id,
        video_id: step.video_id,
      }
    default:
      return null
  }
}

function logPage(eventType: string, page: PageDescriptor, extra: Record<string, unknown> = {}) {
  enqueue('event', {
    event_type: eventType,
    video_id: page.video_id ?? undefined,
    payload: { ...page, ...extra },
    client_ts: Date.now(),
  })
}

export default function SessionPage() {
  const { t } = useTranslation()
  const { logout } = useAuth()
  const toast = useToast()
  const me = useMe()
  const session = useSession()
  const updateProgress = useUpdateProgress()
  const respond = useRespondQuestionnaire()
  const stepBack = useStepBack()
  const unsent = useOutbox(me.data?.id)

  // The supervisor's way back. There is no button: the chord opens a
  // confirmation that names both screens, and the server moves the pointer.
  const [askingBack, setAskingBack] = useState(false)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isStepBackChord(e)) return
      e.preventDefault()
      setAskingBack(true)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const stepNow = session.data?.steps[session.data.current_step_index]
  const pageIndex =
    stepNow && PAGE_KINDS.has(stepNow.kind) ? (session.data?.current_step_index ?? null) : null
  // The outbox only accepts writes once it knows whose they are, and the two
  // queries above land in either order; the entry is logged when both have.
  const ready = Boolean(me.data?.id)
  const stepRef = useRef(stepNow)
  stepRef.current = stepNow
  const enteredRef = useRef<number | null>(null)
  useEffect(() => {
    // Strict mode runs this twice in development; one page is still one entry.
    if (!ready || pageIndex === null || enteredRef.current === pageIndex) return
    enteredRef.current = pageIndex
    const page = stepRef.current ? pageDescriptor(stepRef.current) : null
    if (page) logPage('questionnaire_page_entered', page)
  }, [ready, pageIndex])

  if (me.isLoading || session.isLoading) {
    return <div className="fullpage">{t('session.loading')}</div>
  }
  if (me.isError || !me.data || session.isError || !session.data) {
    return <div className="fullpage is-danger">{t('session.error')}</div>
  }

  const { steps, current_step_index, total_steps } = session.data
  const step = steps[current_step_index]

  const backDialog = askingBack ? (
    <StepBackDialog
      from={step}
      to={current_step_index > 0 ? steps[current_step_index - 1] : undefined}
      atStart={current_step_index <= 0}
      busy={stepBack.isPending}
      onCancel={() => setAskingBack(false)}
      onConfirm={() =>
        stepBack.mutate(undefined, {
          onSuccess: () => setAskingBack(false),
          onError: () => toast.show(t('session.error'), 'error'),
        })
      }
    />
  ) : null

  if (!step || current_step_index >= total_steps) {
    return (
      <>
        <ThanksScreen pendingWrites={unsent} />
        {backDialog}
      </>
    )
  }

  const advance = () => updateProgress.mutate(current_step_index + 1)

  // Every battery submits the same way: store the answers, then move on. A
  // failure keeps the participant on the page with what they typed intact.
  const submitAnswers = async (
    questionnaireId: number,
    videoId: number | null,
    answers: Record<string, unknown>,
    timeSpentSeconds: number,
    page: PageDescriptor | null,
  ) => {
    try {
      await respond.mutateAsync({
        questionnaireId,
        video_id: videoId,
        answers,
        time_spent_seconds: timeSpentSeconds,
      })
      if (page)
        logPage('questionnaire_page_submitted', page, { time_spent_seconds: timeSpentSeconds })
      advance()
    } catch {
      toast.show(t('session.error'), 'error')
    }
  }

  let content: ReactNode
  switch (step.kind) {
    case 'welcome':
      content = (
        <WelcomeScreen
          participantId={me.data.id}
          showCalibration={steps.some((s) => s.kind === 'calibration')}
          texts={step.texts}
          onContinue={advance}
        />
      )
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
      content = <CaseIntroScreen title={step.title} body={step.body} onContinue={advance} />
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
          initialAnswers={qStep.previous_answers ?? undefined}
          onSubmit={(answers, timeSpentSeconds) =>
            submitAnswers(
              qStep.questionnaire_id,
              null,
              answers,
              timeSpentSeconds,
              pageDescriptor(qStep),
            )
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
    case 'diagnosis': {
      const page = pageDescriptor(step)
      content = (
        <DiagnosisScreen
          videoId={step.video_id}
          taskDescription={step.task_description}
          questions={step.questions}
          initialText={step.previous_text}
          initialAnswers={step.previous_answers}
          onComplete={() => {
            // The seconds are on the diagnosis row itself; the event marks when.
            if (page) logPage('questionnaire_page_submitted', page)
            advance()
          }}
        />
      )
      break
    }
    case 'case_outro': {
      const outro = step
      content = (
        <CaseOutroScreen
          instruction={outro.instruction}
          questions={outro.questions}
          submitting={respond.isPending}
          initialAnswers={outro.previous_answers ?? undefined}
          heading={outro.heading}
          body={outro.body}
          onSubmit={(answers, timeSpentSeconds) =>
            outro.questionnaire_id === null
              ? advance()
              : submitAnswers(
                  outro.questionnaire_id,
                  outro.video_id,
                  answers,
                  timeSpentSeconds,
                  pageDescriptor(outro),
                )
          }
        />
      )
      break
    }
    case 'think_aloud': {
      const narration = step
      content = (
        <ThinkAloudScreen
          videoId={narration.video_id}
          position={{
            phaseType: narration.phase_type,
            caseNumber: narration.case_number,
            caseTotal: narration.case_total,
            batchPosition: narration.batch_position,
            batchSize: narration.batch_size,
          }}
          heading={narration.heading}
          body={narration.body}
          onComplete={advance}
        />
      )
      break
    }
    case 'thanks':
      // The hand-over screen: it offers the way back to the id prompt, and
      // needs to know whether this run still has writes in flight.
      content = <ThanksScreen pendingWrites={unsent} />
      break
    default:
      content = <div className="fullpage is-danger">{t('session.error')}</div>
  }

  // Keyed by step, so React never carries one screen's state into the next. The
  // pre-test pages are adjacent steps of the same kind: without this the second
  // page opens holding the first page's answers and submits them again.
  const screen = (
    <Fragment key={current_step_index}>
      {content}
      <SessionGazeCapture step={step} />
    </Fragment>
  )

  // Sits outside the shell: the case screen has no chrome, and that is exactly
  // where notes are written.
  const unsentBanner =
    unsent > 0 ? (
      <div
        className="unsent"
        role="status"
        data-aoi="unsent_notice"
        data-aoi-overlay="true"
        data-aoi-priority="100"
      >
        {t('session.unsent', { count: unsent })}
      </div>
    ) : null

  const progress = Math.round((current_step_index / total_steps) * 100)
  if (CHROMELESS.has(step.kind)) {
    return (
      <>
        {OVERLAY_PROGRESS.has(step.kind) && (
          <div className="shell__progress shell__progress--overlay" aria-hidden="true">
            <div style={{ width: `${progress}%` }} />
          </div>
        )}
        {screen}
        {unsentBanner}
        {backDialog}
      </>
    )
  }
  // Where they are in the study, in the terms they were briefed in — the phase
  // and the case — rather than a step number out of a script only we can see.
  const position = caseAt(steps, current_step_index)
  return (
    <div className="shell">
      {unsentBanner}
      <header className="shell__header">
        <span className="brand-sm">A04</span>
        <span className="muted">
          {position
            ? t('session.case_position', {
                phase: t(`session.phase.${position.phaseType}`, {
                  defaultValue: position.phaseType,
                }),
                current: position.current,
                total: position.total,
              })
            : t('session.questions')}
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
      {backDialog}
    </div>
  )
}
