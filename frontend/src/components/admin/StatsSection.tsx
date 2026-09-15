import { useState } from 'react'

import type { CaseStats, RosterRow } from '../../api/admin'
import { useStudyStats } from '../../hooks/admin'
import {
  bytes,
  compact,
  day,
  duration,
  minutes,
  num,
  percent,
  phaseLabel,
  placementLabel,
  statusLabel,
  tick,
  when,
} from '../../lib/adminFormat'
import ParticipantStatsPanel from './ParticipantStatsPanel'
import { BarRow, Meter, Pill, Stat, StatGrid } from './stat'

const WINDOWS = [7, 30, 90] as const

/**
 * One study in depth. The order is the order a researcher checks things in:
 * are the participants getting through it, is each case being watched, are the
 * questionnaires being answered, and is the tracker behaving. The roster at
 * the bottom is the way into one person's run.
 */
export default function StatsSection({ studyId }: { studyId: number }) {
  const [days, setDays] = useState<number>(30)
  const [selected, setSelected] = useState<string | null>(null)
  const stats = useStudyStats(studyId, days)

  if (stats.isLoading) return <p className="muted">Wird geladen…</p>
  if (stats.isError || !stats.data) return <p className="error-text">Statistik nicht verfügbar.</p>

  const { participants: p, data, cases, questionnaires, calibration, roster, activity } = stats.data
  const screens = data.screens_stored + data.screens_failed

  return (
    <div>
      <div className="flex-between">
        <h2 style={{ margin: 0 }}>Kennzahlen</h2>
        <div className="tabs tabs--inline">
          {WINDOWS.map((w) => (
            <button
              key={w}
              type="button"
              className={days === w ? 'is-active' : ''}
              onClick={() => setDays(w)}
            >
              {w} Tage
            </button>
          ))}
        </div>
      </div>

      <StatGrid>
        <Stat
          label="Teilnehmer"
          value={num(p.total)}
          hint={`${num(p.active)} laufend · ${num(p.registered)} angelegt`}
        />
        <Stat
          label="Abgeschlossen"
          value={num(p.completed)}
          hint={<Meter value={p.completion_rate} />}
        />
        <Stat
          label="Noch nicht begonnen"
          value={num(p.never_started)}
          hint={`${num(p.started)} haben begonnen`}
          tone={p.never_started ? 'warn' : 'default'}
        />
        <Stat label="Ø Fortschritt" value={percent(p.avg_progress)} hint="über alle Teilnehmer" />
        <Stat
          label="Sitzungsdauer"
          value={minutes(p.median_session_minutes)}
          hint={`Median · Ø ${minutes(p.avg_session_minutes)}`}
        />
        <Stat
          label="Videozeit gesamt"
          value={duration(data.watch_seconds)}
          hint="tatsächlich laufendes Video"
        />
      </StatGrid>

      <h3 className="section-head">Erhobene Daten</h3>
      <StatGrid>
        <Stat
          label="Notizen"
          value={num(data.notes)}
          hint={`${compact(data.note_chars)} Zeichen`}
        />
        <Stat label="Diagnosen" value={num(data.diagnoses)} />
        <Stat label="Fragebogen-Antworten" value={num(data.responses)} />
        <Stat label="Ereignisse" value={compact(data.events)} />
        <Stat
          label="Gaze"
          value={compact(data.gaze_samples)}
          hint={`${num(p.with_gaze)} von ${num(p.total)} Teilnehmern`}
          tone={p.total && !p.with_gaze ? 'warn' : 'default'}
        />
        <Stat
          label="Bildschirmaufnahmen"
          value={num(data.screens_stored)}
          hint={
            data.screens_failed
              ? `${num(data.screens_failed)} fehlgeschlagen von ${num(screens)}`
              : bytes(data.screen_bytes)
          }
          tone={data.screens_failed ? 'bad' : 'default'}
        />
      </StatGrid>

      <div className="card">
        <h3>Aktivität ({days} Tage)</h3>
        <BarRow
          items={activity.map((a) => ({
            key: a.date,
            label: tick(a.date),
            value: a.events,
          }))}
        />
      </div>

      <div className="card">
        <h3>Fälle</h3>
        <p className="muted">
          „Gesehen“ ist die reine Abspielzeit; „am Schirm“ ist die Zeit auf dem Fall-Bildschirm,
          also inklusive Lesen, Notieren und geöffneter Dialoge.
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Fall</th>
                <th>Phase</th>
                <th className="num">Zugewiesen</th>
                <th className="num">Gesehen von</th>
                <th className="num">Ø gesehen</th>
                <th className="num">Ø am Schirm</th>
                <th>Abdeckung</th>
                <th className="num">Pausen</th>
                <th className="num">Sprünge</th>
                <th className="num">Notizen</th>
                <th className="num">Diagnosen</th>
                <th className="num">Gaze</th>
                <th>Aufnahmen</th>
              </tr>
            </thead>
            <tbody>
              {cases.map((c) => (
                <CaseRow key={c.video_id} row={c} />
              ))}
              {!cases.length && (
                <tr>
                  <td colSpan={13} className="muted">
                    Noch keine Videos in dieser Studie.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Fragebögen</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Titel</th>
                <th>Platzierung</th>
                <th className="num">Fragen</th>
                <th className="num">Antworten</th>
                <th>Vollständigkeit</th>
                <th className="num">Ø Dauer</th>
                <th>Zuletzt</th>
              </tr>
            </thead>
            <tbody>
              {questionnaires.map((q) => (
                <tr key={q.id}>
                  <td>{q.title}</td>
                  <td>{placementLabel(q.placement)}</td>
                  <td className="num">{num(q.questions)}</td>
                  <td className="num">
                    {num(q.responses)}
                    <div className="muted small">{num(q.participants)} Teilnehmer</div>
                  </td>
                  <td style={{ minWidth: 120 }}>
                    <Meter value={q.completion} label={`${num(q.responses)}/${num(q.expected)}`} />
                  </td>
                  <td className="num">{duration(q.avg_seconds)}</td>
                  <td>{day(q.last_response_at)}</td>
                </tr>
              ))}
              {!questionnaires.length && (
                <tr>
                  <td colSpan={7} className="muted">
                    Noch keine Fragebögen.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <h3>Eye-Tracking-Kalibrierung</h3>
        <p className="muted">
          Der Versatz ist der mittlere Abstand zwischen Zielpunkt und gemessenem Blick, als Anteil
          der Bildschirmbreite. Er entscheidet, ob die Blickdaten überhaupt verwertbar sind.
        </p>
        {calibration.attempts ? (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Ergebnis</th>
                  <th className="num">Versuche</th>
                  <th className="num">Teilnehmer</th>
                  <th className="num">Ø Versatz</th>
                  <th className="num">Bester</th>
                  <th className="num">Schlechtester</th>
                  <th className="num">Ø Grad</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(calibration.by_status).map(([status, b]) => (
                  <tr key={status}>
                    <td>
                      {status === 'success' ? (
                        <Pill tone="ok">erfolgreich</Pill>
                      ) : status === 'failed' ? (
                        <Pill tone="bad">fehlgeschlagen</Pill>
                      ) : (
                        <Pill tone="idle">übersprungen</Pill>
                      )}
                    </td>
                    <td className="num">{num(b.attempts)}</td>
                    <td className="num">{num(b.participants)}</td>
                    <td className="num">{num(b.avg_offset, 4)}</td>
                    <td className="num">{num(b.best_offset, 4)}</td>
                    <td className="num">{num(b.worst_offset, 4)}</td>
                    <td className="num">{num(b.avg_offset_degrees, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="muted">Noch keine Kalibrierung aufgezeichnet.</p>
        )}
      </div>

      <div className="card">
        <h3>Teilnehmer</h3>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Status</th>
                <th>Fortschritt</th>
                <th className="num">Dauer</th>
                <th className="num">Gesehen</th>
                <th className="num">Notizen</th>
                <th className="num">Diagnosen</th>
                <th className="num">Antworten</th>
                <th className="num">Gaze</th>
                <th>Aufnahmen</th>
                <th>Zuletzt aktiv</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {roster.map((r) => (
                <RosterLine key={r.id} row={r} onOpen={() => setSelected(r.id)} />
              ))}
              {!roster.length && (
                <tr>
                  <td colSpan={12} className="muted">
                    Noch keine Teilnehmer.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {selected && (
        <ParticipantStatsPanel participantId={selected} onClose={() => setSelected(null)} />
      )}

      <p className="muted">Stand: {when(stats.data.generated_at)}</p>
    </div>
  )
}

function CaseRow({ row }: { row: CaseStats }) {
  return (
    <tr>
      <td>
        {row.title}
        <div className="muted small">
          {row.duration_seconds ? duration(row.duration_seconds) : 'Länge unbekannt'}
          {row.has_file ? '' : ' · keine Datei'}
        </div>
      </td>
      <td>{phaseLabel(row.phase_type)}</td>
      <td className="num">{num(row.assigned)}</td>
      <td className="num">{num(row.viewers)}</td>
      <td className="num">{duration(row.avg_watch_seconds)}</td>
      <td className="num">{duration(row.avg_on_screen_seconds)}</td>
      <td style={{ minWidth: 110 }}>
        {row.avg_coverage == null ? (
          <span className="muted">—</span>
        ) : (
          <Meter value={row.avg_coverage} />
        )}
      </td>
      <td className="num">{num(row.pauses)}</td>
      <td className="num">
        {num(row.seeks)}
        {row.replays > 0 && <div className="muted small">{num(row.replays)} erneut</div>}
      </td>
      <td className="num">
        {num(row.notes)}
        <div className="muted small">{num(row.note_writers)} Pers.</div>
      </td>
      <td className="num">
        {num(row.diagnoses)}
        <div className="muted small">Ø {num(row.avg_diagnosis_chars)} Z.</div>
      </td>
      <td className="num">{compact(row.gaze_samples)}</td>
      <td>
        {row.screens_failed ? (
          <Pill tone="bad">{num(row.screens_failed)} fehlg.</Pill>
        ) : row.screens_stored ? (
          <Pill tone="ok">{num(row.screens_stored)}</Pill>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
    </tr>
  )
}

function RosterLine({ row, onOpen }: { row: RosterRow; onOpen: () => void }) {
  return (
    <tr>
      <td>
        {row.id}
        {row.video_set ? (
          <div className="muted small">Set {row.video_set}</div>
        ) : (
          !row.assigned_sequence && <div className="muted small">Standardreihenfolge</div>
        )}
      </td>
      <td>
        {row.status === 'completed' ? (
          <Pill tone="ok">{statusLabel(row.status)}</Pill>
        ) : row.status === 'active' ? (
          <Pill tone="warn">{statusLabel(row.status)}</Pill>
        ) : (
          <Pill tone="idle">{statusLabel(row.status)}</Pill>
        )}
      </td>
      <td style={{ minWidth: 130 }}>
        <Meter value={row.progress} label={`Schritt ${row.step}/${row.total_steps}`} />
      </td>
      <td className="num">{minutes(row.session_minutes)}</td>
      <td className="num">{duration(row.watch_seconds)}</td>
      <td className="num">{num(row.notes)}</td>
      <td className="num">{num(row.diagnoses)}</td>
      <td className="num">{num(row.responses)}</td>
      <td className="num">{compact(row.gaze_samples)}</td>
      <td>
        {row.screens_failed ? (
          <Pill tone="bad">{num(row.screens_failed)} fehlg.</Pill>
        ) : row.screens_stored ? (
          <Pill tone="ok">{num(row.screens_stored)}</Pill>
        ) : (
          <span className="muted">—</span>
        )}
      </td>
      <td>{day(row.last_event_at)}</td>
      <td>
        <button type="button" className="btn btn-secondary btn-sm" onClick={onOpen}>
          Details
        </button>
      </td>
    </tr>
  )
}
