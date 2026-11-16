import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'

import type { QuestionnaireVisit, SectionTiming, SessionStep } from '../../api/participant'
import { useEnterQuestionnaire, useFinishCK } from '../../hooks/participant'
import { useLocalDraft } from '../../hooks/useLocalDraft'
import { enqueue } from '../../lib/outbox'
import type { Answers } from '../../lib/questionnaire'
import Modal from '../Modal'
import QuestionnaireRenderer from './QuestionnaireRenderer'
import './PreTestPage.css'

type QuestionnaireStep = Extract<SessionStep, { kind: 'questionnaire' }>

function restoredAnswers(draft: string, previous: Answers | null | undefined): Answers {
  try {
    const parsed: unknown = JSON.parse(draft)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Answers
  } catch {
    /* no readable local draft */
  }
  return previous ?? {}
}

export function SectionTimer({
  timing,
  onExpire,
}: {
  timing: SectionTiming | null | undefined
  onExpire?: () => void
}) {
  const { t } = useTranslation()
  const [now, setNow] = useState(Date.now)
  // Anchor to the server clock once per response, including when restoring an expired page.
  const offset = useMemo(() => (timing ? timing.server_now_ms - Date.now() : 0), [timing])
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(interval)
  }, [])
  const remaining = timing
    ? Math.min(420, Math.max(0, Math.ceil((timing.deadline_ms - now - offset) / 1000)))
    : null
  useEffect(() => {
    if (remaining === 0 && timing && !timing.finished) onExpire?.()
  }, [remaining, timing, onExpire])
  if (!timing || remaining === null) return <p className="muted">{t('ck_section.starting')}</p>
  const display = Math.floor(remaining / 60) + ':' + String(remaining % 60).padStart(2, '0')
  return (
    <div className="section-timer" data-aoi="section_timer">
      <span>{t('ck_section.time_remaining')}</span>
      <strong role="timer" aria-label={t('ck_section.time_remaining')}>
        {display}
      </strong>
      {(remaining === 0 || timing.finished) && (
        <span role="status">
          {t(
            timing.finished
              ? 'ck_section.review'
              : onExpire
                ? 'ck_section.expiry_saving'
                : 'ck_section.expired',
          )}
        </span>
      )}
    </div>
  )
}

export default function PreTestPage({
  step,
  participantId,
  timing,
  submitting,
  onSubmit,
  onVisitReady,
  onBusyChange,
  finishRequested,
  onCloseFinish,
  pilot = false,
  onTimerFinished,
}: {
  step: QuestionnaireStep
  pilot?: boolean
  onTimerFinished?: () => void
  participantId: string
  timing?: SectionTiming | null
  submitting: boolean
  onVisitReady: (visitId: string) => void
  onBusyChange: (busy: boolean) => void
  finishRequested: boolean
  onCloseFinish: () => void
  onSubmit: (
    answers: Answers,
    seconds: number,
    visitId?: string,
    clientTs?: number,
  ) => Promise<boolean>
}) {
  const { t } = useTranslation()
  const [draft, saveDraft, clearDraft] = useLocalDraft(
    participantId + ':questionnaire:' + step.questionnaire_id,
  )
  const [initial] = useState(() => restoredAnswers(draft, step.previous_answers))
  const answers = useRef(initial)
  const [visitId] = useState(() => crypto.randomUUID())
  const [enteredAt] = useState(Date.now)
  const requestId = useRef(crypto.randomUUID())
  const pendingFinish = useRef<{
    expected_step_index: number
    visit_id: string
    request_id: string
    client_ts: number
    answers: Answers
    reason: 'supervisor' | 'timer_expired'
  } | null>(null)
  const started = useRef(false)
  const finishing = useRef(false)
  const autoAttempted = useRef(false)
  const [finishAttempt, setFinishAttempt] = useState(0)
  const [expired, setExpired] = useState(false)
  const closeDialog = useRef(onCloseFinish)
  closeDialog.current = onCloseFinish
  const markExpired = useCallback(() => {
    setExpired(true)
    // A confirmation dialog must not defer the seven-minute deadline.
    closeDialog.current()
  }, [])
  const mounted = useRef(true)
  const enter = useEnterQuestionnaire()
  const finish = useFinishCK()
  const finishPage = finish.mutateAsync
  const [visit, setVisit] = useState<QuestionnaireVisit | null>(null)
  const askingFinish = finishRequested && !expired
  const [error, setError] = useState('')
  const timed = step.section_key === 'ck_tasks'
  const matrixPage =
    step.questions.length > 0 && step.questions.every((question) => question.matrix)
  const demographics =
    step.section_key === 'demographics' ||
    ['participant_group', 'sex', 'age'].every((id) =>
      step.questions.some((question) => question.id === id),
    )
  const pageClasses = [
    'pretest-page',
    pilot && 'pretest-page--pilot',
    timed && 'pretest-page--ck',
    step.section_key === 'pck' && 'pretest-page--pck',
    pilot && step.section_key === 'mesp' && 'pretest-page--mesp',
    matrixPage && 'pretest-page--matrix',
    matrixPage && step.description.length > 800 && 'pretest-page--instructions',
    demographics && 'pretest-page--demographics',
  ]
    .filter(Boolean)
    .join(' ')
  const needsVisit = Boolean(step.section_key)
  const enterPage = enter.mutateAsync
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])
  useEffect(() => {
    onBusyChange(askingFinish || finish.isPending || expired)
    return () => onBusyChange(false)
  }, [askingFinish, finish.isPending, expired, onBusyChange])

  const beginVisit = useCallback(() => {
    setError('')
    return enterPage({
      step_index: step.index,
      questionnaire_id: step.questionnaire_id,
      visit_id: visitId,
      client_ts: enteredAt,
    })
      .then((value) => {
        if (!mounted.current) return
        setVisit(value)
        onVisitReady(value.visit_id)
        enqueue('event', {
          event_type: 'questionnaire_page_entered',
          client_ts: enteredAt,
          payload: {
            kind: step.kind,
            title: step.title,
            section: step.section,
            section_key: step.section_key,
            questionnaire_id: step.questionnaire_id,
            page: step.page,
            page_count: step.page_count,
            visit_id: value.visit_id,
          },
        })
      })
      .catch(() => {
        if (mounted.current) setError(t('ck_section.visit_error'))
      })
  }, [enterPage, step, visitId, enteredAt, t, onVisitReady])

  useEffect(() => {
    if (!needsVisit || started.current) return
    started.current = true
    void beginVisit()
  }, [needsVisit, beginVisit])

  const changed = useCallback(
    (next: Answers) => {
      answers.current = next
      saveDraft(JSON.stringify(next))
    },
    [saveDraft],
  )

  const finishSection = useCallback(
    async (reason: 'supervisor' | 'timer_expired' = 'supervisor') => {
      if (!visit || finishing.current) return
      finishing.current = true
      // A rejected supervisor snapshot may contain invalid fields. Once time is up,
      // start a new expiry request so the server can preserve its partial content.
      if (reason === 'timer_expired' && pendingFinish.current?.reason === 'supervisor') {
        pendingFinish.current = null
        requestId.current = crypto.randomUUID()
      }
      pendingFinish.current ??= {
        expected_step_index: step.index,
        visit_id: visitId,
        request_id: requestId.current,
        client_ts: Date.now(),
        answers: structuredClone(answers.current),
        reason,
      }
      const payload = pendingFinish.current
      setError('')
      try {
        await finishPage(payload)
        enqueue('event', {
          event_type: 'questionnaire_page_exited',
          client_ts: payload.client_ts,
          payload: {
            kind: step.kind,
            section: step.section,
            section_key: step.section_key,
            questionnaire_id: step.questionnaire_id,
            visit_id: visitId,
            title: step.title,
            reason: payload.reason === 'timer_expired' ? 'timer_expired' : 'supervisor_finished',
          },
        })
        if (payload.reason === 'timer_expired') onTimerFinished?.()
        clearDraft()
        pendingFinish.current = null
        onCloseFinish()
      } catch {
        if (mounted.current) setError(t('ck_section.finish_error'))
      } finally {
        finishing.current = false
        if (mounted.current) setFinishAttempt((count) => count + 1)
      }
    },
    [visit, step, visitId, finishPage, onTimerFinished, clearDraft, onCloseFinish, t],
  )

  useEffect(() => {
    const clock = visit?.section_timing ?? timing
    if (
      !pilot ||
      !timed ||
      !expired ||
      !visit ||
      submitting ||
      clock?.finished ||
      finish.isPending ||
      finishing.current ||
      autoAttempted.current
    )
      return
    autoAttempted.current = true
    onCloseFinish()
    void finishSection('timer_expired')
  }, [
    pilot,
    timed,
    expired,
    visit,
    timing,
    submitting,
    finish.isPending,
    finishAttempt,
    finishSection,
    onCloseFinish,
  ])

  // A disconnected timer exit keeps its immutable answer snapshot and resumes on reconnect.
  useEffect(() => {
    if (!expired || !error) return
    const retry = () => {
      void finishSection('timer_expired')
    }
    window.addEventListener('online', retry)
    return () => window.removeEventListener('online', retry)
  }, [expired, error, finishSection])

  const cancelFinish = () => {
    if (finish.isPending) return
    pendingFinish.current = null
    requestId.current = crypto.randomUUID()
    onCloseFinish()
  }

  return (
    <div className={pageClasses}>
      {timed && (
        <SectionTimer
          timing={visit?.section_timing ?? timing}
          onExpire={pilot ? markExpired : undefined}
        />
      )}
      {error && !askingFinish && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      {expired && error && visit && (
        <button
          className="btn btn-secondary"
          disabled={finish.isPending}
          onClick={() => void finishSection('timer_expired')}
        >
          {t('ck_section.retry')}
        </button>
      )}
      {needsVisit && !visit && enter.isError && (
        <button
          className="btn btn-secondary"
          disabled={enter.isPending}
          onClick={() => void beginVisit()}
        >
          {t('ck_section.retry')}
        </button>
      )}
      <QuestionnaireRenderer
        title={step.title}
        description={t('pre_test.page', { current: step.page, total: step.page_count })}
        instruction={step.description}
        questions={step.questions}
        layout={pilot && step.section_key === 'pck' ? 'columns' : undefined}
        initialAnswers={initial}
        onAnswersChange={changed}
        disabled={
          submitting ||
          askingFinish ||
          expired ||
          finish.isPending ||
          pendingFinish.current !== null
        }
        submitting={submitting || finish.isPending || (needsVisit && !visit)}
        onSkip={
          pilot &&
          timed &&
          step.questions.length > 0 &&
          step.questions.every((q) => q.type === 'debugging' && q.allow_skip)
            ? async (seconds) => {
                const skipped = Object.fromEntries(
                  step.questions.map((q) => [q.id, { lines: [0], explanation: '', skipped: true }]),
                )
                const saved = await onSubmit(
                  skipped,
                  seconds,
                  needsVisit ? visitId : undefined,
                  Date.now(),
                )
                if (saved) clearDraft()
              }
            : undefined
        }
        onSubmit={async (next, seconds) => {
          const saved = await onSubmit(next, seconds, needsVisit ? visitId : undefined, Date.now())
          if (saved) clearDraft()
        }}
      />
      {askingFinish && (
        <Modal
          open
          title={t('ck_section.finish_title')}
          onClose={cancelFinish}
          aoiId="supervisor_dialog"
        >
          <p>{t('ck_section.finish_body')}</p>
          <p className="muted">{t('ck_section.finish_note')}</p>
          {error && (
            <p className="error-text" role="alert">
              {error}
            </p>
          )}
          <div className="modal__actions">
            <button className="btn btn-ghost" disabled={finish.isPending} onClick={cancelFinish}>
              {t('step_back.cancel')}
            </button>
            <button
              className="btn btn-primary"
              disabled={!visit || finish.isPending || submitting}
              onClick={() => void finishSection()}
            >
              {t('ck_section.finish_confirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  )
}
