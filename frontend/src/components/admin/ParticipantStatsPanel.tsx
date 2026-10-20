import { useEffect, useRef } from 'react'

import type { ParticipantCaseStats, ParticipantSectionTime } from '../../api/admin'
import { useParticipantStats } from '../../hooks/admin'
import {
  bytes,
  compact,
  duration,
  minutes,
  num,
  percent,
  phaseLabel,
  placementLabel,
  statusLabel,
  stepLabel,
  when,
} from '../../lib/adminFormat'
import { Facts, Meter, Pill, Stat, StatGrid } from './stat'

/**
 * One participant's run, case by case.
 *
 * The per-case block is the point of this panel: it puts the behaviour
 * (watching, pausing, note-taking) next to what was captured while it happened
 * (gaze samples, the screen recording), so a case whose data is unusable can
 * be told from one the participant simply rushed.
 */
export default function ParticipantStatsPanel({
  participantId,
  onClose,
  onReady,
}: {
  participantId: string
  onClose: () => void
  onReady?: () => void
}) {
  const stats = useParticipantStats(participantId)
  const initialLoad = useRef({ participantId, waiting: stats.isLoading })

  useEffect(() => {
    if (initialLoad.current.participantId !== participantId) {
      initialLoad.current = { participantId, waiting: stats.isLoading }
    }
    if (!stats.isLoading && initialLoad.current.waiting) {
      initialLoad.current.waiting = false
      // The growing loading card can push its heading out of view. Reveal
      // the first result once; later refreshes must leave the reader in place.
      onReady?.()
    }
  }, [participantId, stats.isLoading, onReady])

  return (
    <div className="card participant-stats">
      <div className="flex-between">
        <h3 style={{ margin: 0 }}>Teilnehmer {participantId}</h3>
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          Schließen
        </button>
      </div>

      {stats.isLoading && <p className="muted">Wird geladen…</p>}
      {stats.isError && <p className="error-text">Statistik nicht verfügbar.</p>}

      {stats.data && (
        <>
          <StatGrid>
            <Stat
              label="Status"
              value={statusLabel(stats.data.status)}
              hint={
                stats.data.session.current_step
                  ? `bei: ${stepLabel(stats.data.session.current_step)}`
                  : 'noch nicht begonnen'
              }
            />
            <Stat
              label="Fortschritt"
              value={percent(stats.data.session.progress)}
              hint={
                <Meter
                  value={stats.data.session.progress}
                  label={`Schritt ${stats.data.session.step}/${stats.data.session.total_steps}`}
                />
              }
            />
            <Stat
              label="Sitzungsdauer"
              value={minutes(stats.data.session.minutes ?? stats.data.activity.minutes)}
              hint={
                stats.data.session.completed_at
                  ? 'abgeschlossen'
                  : `${num(stats.data.activity.events)} Ereignisse`
              }
            />
            <Stat
              label="Fälle bearbeitet"
              value={`${num(stats.data.totals.cases_entered)}/${num(stats.data.totals.cases)}`}
              hint={`${num(stats.data.totals.cases_completed)} Videos zu Ende gesehen`}
            />
            <Stat
              label="Videozeit"
              value={duration(stats.data.totals.watch_seconds)}
              hint={`${duration(stats.data.totals.on_screen_seconds)} am Fall-Bildschirm`}
            />
            <Stat
              label="Gaze-Samples"
              value={compact(stats.data.totals.gaze_samples)}
              hint={
                stats.data.totals.screens_failed
                  ? `${num(stats.data.totals.screens_failed)} Aufnahmen fehlgeschlagen`
                  : `${num(stats.data.totals.screens_stored)} Aufnahmen · ${bytes(stats.data.totals.screen_bytes)}`
              }
              tone={stats.data.totals.screens_failed ? 'bad' : 'default'}
            />
          </StatGrid>

          <Facts
            rows={[
              ['Studie', stats.data.study_name],
              ['Angelegt', when(stats.data.created_at)],
              ['Begonnen', when(stats.data.session.started_at)],
              ['Abgeschlossen', when(stats.data.session.completed_at)],
              [
                'Reihenfolge',
                stats.data.session.video_set
                  ? `Set ${stats.data.session.video_set}`
                  : stats.data.session.assigned_sequence
                    ? 'individuell zugewiesen'
                    : 'Standard der Studie',
              ],
              [
                'Geschrieben',
                `${num(stats.data.totals.notes)} Notizen (${compact(stats.data.totals.note_chars)} Zeichen) · ${num(stats.data.totals.diagnosis_words)} Wörter Diagnose`,
              ],
            ]}
          />

          <h4 className="section-head">Fälle</h4>
          <div className="case-cards">
            {stats.data.cases.map((c) => (
              <CaseCard key={c.video_id} row={c} />
            ))}
            {!stats.data.cases.length && (
              <p className="muted">Diesem Teilnehmer sind keine Fälle zugewiesen.</p>
            )}
          </div>

          <h4 className="section-head">Fragebögen</h4>
          {stats.data.sections.length > 0 && <SectionTotals rows={stats.data.sections} />}
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Titel</th>
                  <th>Abschnitt</th>
                  <th>Platzierung</th>
                  <th>Fall</th>
                  <th className="num">Beantwortet</th>
                  <th className="num">Dauer</th>
                  <th>Zeitpunkt</th>
                </tr>
              </thead>
              <tbody>
                {stats.data.questionnaires.map((q) => (
                  <tr key={q.response_id}>
                    <td>{q.title}</td>
                    <td className="muted">{q.section || '—'}</td>
                    <td>{placementLabel(q.placement)}</td>
                    <td className="muted">{q.video_title ?? '—'}</td>
                    <td className="num">
                      {num(q.answered)}/{num(q.questions)}
                    </td>
                    <td className="num">{duration(q.seconds)}</td>
                    <td>{when(q.created_at)}</td>
                  </tr>
                ))}
                {!stats.data.questionnaires.length && (
                  <tr>
                    <td colSpan={7} className="muted">
                      Noch nichts beantwortet.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <h4 className="section-head">Kalibrierung</h4>
          {stats.data.calibrations.length ? (
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Ergebnis</th>
                    <th className="num">Versatz</th>
                    <th className="num">Grad</th>
                    <th className="num">Punkte</th>
                    <th>Zeitpunkt</th>
                  </tr>
                </thead>
                <tbody>
                  {stats.data.calibrations.map((c) => (
                    <tr key={c.id}>
                      <td>
                        {c.status === 'success' ? (
                          <Pill tone="ok">erfolgreich</Pill>
                        ) : c.status === 'failed' ? (
                          <Pill tone="bad">fehlgeschlagen</Pill>
                        ) : (
                          <Pill tone="idle">übersprungen</Pill>
                        )}
                      </td>
                      <td className="num">{num(c.mean_offset, 4)}</td>
                      <td className="num">{num(c.mean_offset_degrees, 2)}</td>
                      <td className="num">{num(c.points)}</td>
                      <td>{when(c.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted">Keine Kalibrierung aufgezeichnet.</p>
          )}

          <h4 className="section-head">Ereignisse</h4>
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Ereignis</th>
                  <th>Variable</th>
                  <th className="num">Anzahl</th>
                  <th>Zuerst</th>
                  <th>Zuletzt</th>
                </tr>
              </thead>
              <tbody>
                {stats.data.events_by_type.map((e) => (
                  <tr key={e.event_type}>
                    <td>{e.event_type}</td>
                    <td className="muted">{e.variable_name || '—'}</td>
                    <td className="num">{num(e.count)}</td>
                    <td>{when(e.first_at)}</td>
                    <td>{when(e.last_at)}</td>
                  </tr>
                ))}
                {!stats.data.events_by_type.length && (
                  <tr>
                    <td colSpan={5} className="muted">
                      Noch keine Ereignisse.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}

/**
 * Time per section — every page of "Demographics" or "CK-Pretest" this person
 * answered, added up — and the pre-test as a whole, which is the figure the
 * researchers asked for first.
 */
function SectionTotals({ rows }: { rows: ParticipantSectionTime[] }) {
  const preTest = rows.filter((s) => s.pre_test && s.seconds != null)
  const lines = rows.map((s): [string, string] => [
    s.section,
    `${duration(s.seconds)} · ${num(s.pages)} ${s.pages === 1 ? 'Seite' : 'Seiten'}`,
  ])
  if (preTest.length) {
    const total = preTest.reduce((sum, s) => sum + (s.seconds ?? 0), 0)
    lines.push(['Vortest gesamt', duration(total)])
  }
  return <Facts rows={lines} />
}

function CaseCard({ row }: { row: ParticipantCaseStats }) {
  const screen = row.screen
  return (
    <section className={`case-card${row.entered ? '' : ' case-card--untouched'}`}>
      <header className="case-card__head">
        <div>
          <strong>
            {row.slot_index + 1}. {row.title}
          </strong>
          <span className="muted small"> · {phaseLabel(row.phase_type)}</span>
        </div>
        {row.completed ? (
          <Pill tone="ok">zu Ende gesehen</Pill>
        ) : row.entered ? (
          <Pill tone="warn">abgebrochen</Pill>
        ) : (
          <Pill tone="idle">nicht erreicht</Pill>
        )}
      </header>

      {row.entered ? (
        <>
          <div className="case-card__meter">
            <span className="rail-label">Abdeckung des Videos</span>
            <Meter
              value={row.coverage}
              label={
                row.duration_seconds
                  ? `${duration(row.max_playhead_seconds)} von ${duration(row.duration_seconds)}`
                  : duration(row.max_playhead_seconds)
              }
            />
          </div>
          <Facts
            rows={[
              [
                'Zeit',
                `${duration(row.watch_seconds)} Video · ${duration(row.on_screen_seconds)} am Schirm`,
              ],
              [
                'Steuerung',
                `${num(row.plays)}× Play · ${num(row.pauses)}× Pause · ${num(row.seeks)}× Sprung${
                  row.replays ? ` · ${num(row.replays)}× erneut` : ''
                }`,
              ],
              [
                'Notizen',
                `${num(row.notes.snapshots)} Stände · ${num(row.notes.chars)} Zeichen · ${num(
                  row.typing_bursts,
                )} Tippphasen`,
              ],
              ['Dialoge', `${num(row.info_opens)}× Info · ${num(row.task_opens)}× Schüler-Aufgabe`],
              [
                'Diagnose',
                row.diagnosis
                  ? `${num(row.diagnosis.words)} Wörter in ${duration(row.diagnosis.seconds)}`
                  : 'nicht abgegeben',
              ],
              [
                'Fragen danach',
                [
                  row.ratings_answered ? 'Einschätzung ✓' : 'Einschätzung offen',
                  row.outro_answered ? 'Abschlussfragen ✓' : 'Abschlussfragen offen',
                ].join(' · '),
              ],
              [
                'Gaze',
                row.gaze.recordings
                  ? `${compact(row.gaze.samples)} Samples${
                      row.gaze.yield == null ? '' : ` · ${percent(row.gaze.yield)} Ausbeute`
                    }${row.gaze.sampling_rate_hz ? ` · ${row.gaze.sampling_rate_hz} Hz` : ''}`
                  : 'nicht aufgezeichnet',
              ],
              [
                'Bildschirm',
                screen
                  ? screen.status === 'stored'
                    ? `${duration((screen.duration_ms ?? 0) / 1000)} · ${bytes(screen.byte_size)}${
                        screen.width ? ` · ${screen.width}×${screen.height}` : ''
                      }${screen.recorder === 'browser' ? ' · vom Browser aufgezeichnet' : ''}`
                    : screen.status === 'failed'
                      ? `fehlgeschlagen: ${screen.error ?? 'ohne Angabe'}`
                      : 'Upload ausstehend'
                  : 'nicht aufgezeichnet',
              ],
            ]}
          />
        </>
      ) : (
        <p className="muted">
          Der Teilnehmer hat diesen Fall noch nicht geöffnet.
          {row.screen?.status === 'failed' && ' Eine Aufnahme ist dennoch fehlgeschlagen.'}
        </p>
      )}
    </section>
  )
}
