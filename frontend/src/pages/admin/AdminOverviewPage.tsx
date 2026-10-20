import { useState } from 'react'
import { Link } from 'react-router-dom'

import type { StudyStatRow } from '../../api/admin'
import { BarRow, Meter, Pill, Stat, StatGrid } from '../../components/admin/stat'
import ResearchersSection from '../../components/admin/ResearchersSection'
import { useAuth } from '../../contexts/AuthContext'
import { useOverviewStats } from '../../hooks/admin'
import {
  average,
  bytes,
  compact,
  day,
  duration,
  minutes,
  num,
  percent,
  tick,
  when,
} from '../../lib/adminFormat'

const WINDOWS = [7, 30, 90] as const

/**
 * Every study at once. Two questions get asked of this page, in this order:
 * how far along is the data collection, and is anything going missing. So the
 * headline row is participants and completion, and the row under it is the
 * three captures that fail quietly — gaze, the screen recording, and
 * calibration.
 */
export default function AdminOverviewPage() {
  const { user, login } = useAuth()
  return (
    <div>
      <OverviewStats />
      <ResearchersSection me={user?.id ?? null} onNewToken={login} />
    </div>
  )
}

function OverviewStats() {
  const [days, setDays] = useState<number>(30)
  const stats = useOverviewStats(days)

  if (stats.isLoading) return <p className="muted">Wird geladen…</p>
  if (stats.isError || !stats.data) return <p className="error-text">Statistik nicht verfügbar.</p>

  const { totals, studies, activity, events_by_type: events } = stats.data
  const screenLoss = totals.screen_recordings
    ? (totals.screens_failed / totals.screen_recordings) * 100
    : null

  return (
    <div>
      <div className="flex-between">
        <h1>Übersicht</h1>
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
          value={num(totals.participants)}
          hint={`${num(totals.active)} laufend · ${num(totals.registered)} angelegt`}
        />
        <Stat
          label="Abgeschlossen"
          value={num(totals.completed)}
          hint={<Meter value={totals.completion_rate} />}
        />
        <Stat
          label="Studien"
          value={num(totals.studies)}
          hint={`${num(totals.active_studies)} aktiv · ${num(totals.researchers)} Forschende`}
        />
        <Stat
          label="Videos"
          value={num(totals.videos)}
          hint={
            totals.videos > totals.videos_with_file
              ? `${num(totals.videos - totals.videos_with_file)} ohne Datei`
              : 'alle mit Datei'
          }
          tone={totals.videos > totals.videos_with_file ? 'warn' : 'default'}
        />
        <Stat
          label="Ø Sitzungsdauer"
          value={minutes(
            average(
              studies.map((s) => s.avg_session_minutes).filter((v): v is number => v != null),
            ),
          )}
          hint={`${num(totals.finished)} beendete Sitzungen`}
        />
      </StatGrid>

      <h2 className="section-head">Erhobene Daten</h2>
      <StatGrid>
        <Stat label="Notizen" value={compact(totals.notes)} hint="Momentaufnahmen" />
        <Stat label="Diagnosen" value={compact(totals.diagnoses)} />
        <Stat label="Fragebogen-Antworten" value={compact(totals.responses)} />
        <Stat label="Ereignisse" value={compact(totals.events)} hint="Interaktions-Log" />
        <Stat
          label="Gaze-Samples"
          value={compact(totals.gaze_samples)}
          hint={`${num(totals.gaze_recordings)} Aufzeichnungen`}
        />
        <Stat
          label="Bildschirmaufnahmen"
          value={num(totals.screens_stored)}
          hint={
            totals.screens_failed
              ? `${num(totals.screens_failed)} fehlgeschlagen (${percent(screenLoss)})`
              : bytes(totals.screen_bytes)
          }
          tone={totals.screens_failed ? 'bad' : 'default'}
        />
        <Stat
          label="Kalibrierungen"
          value={num(totals.calibrations_ok)}
          hint={`von ${num(totals.calibrations)} Versuchen`}
          tone={
            totals.calibrations && totals.calibrations_ok < totals.calibrations ? 'warn' : 'default'
          }
        />
        <Stat label="Speicher (Aufnahmen)" value={bytes(totals.screen_bytes)} />
      </StatGrid>

      <div className="card">
        <h2>Aktivität ({days} Tage)</h2>
        <p className="muted">Ereignisse pro Tag; die Zahl darunter ist das Datum.</p>
        <BarRow
          items={activity.map((a) => ({
            key: a.date,
            label: tick(a.date),
            value: a.events,
          }))}
        />
      </div>

      <h2 className="section-head">Studien</h2>
      <div className="table-scroll">
        <table className="table">
          <thead>
            <tr>
              <th>Studie</th>
              <th>Status</th>
              <th className="num">Teilnehmer</th>
              <th>Fortschritt</th>
              <th className="num">Videos</th>
              <th className="num">Notizen</th>
              <th className="num">Diagnosen</th>
              <th className="num">Gaze</th>
              <th>Aufnahmen</th>
              <th>Zuletzt aktiv</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {studies.map((s) => (
              <StudyRow key={s.id} row={s} />
            ))}
            {!studies.length && (
              <tr>
                <td colSpan={11} className="muted">
                  Noch keine Studien.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h2>Häufigste Ereignisse</h2>
        <p className="muted">
          Der Variablenname ist der Name aus dem Codebuch; leer heißt, das Ereignis gehört uns und
          nicht der Auswertung.
        </p>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Ereignis</th>
                <th>Variable</th>
                <th className="num">Anzahl</th>
                <th className="num">Teilnehmer</th>
              </tr>
            </thead>
            <tbody>
              {events.slice(0, 25).map((e) => (
                <tr key={e.event_type}>
                  <td>{e.event_type}</td>
                  <td className="muted">{e.variable_name || '—'}</td>
                  <td className="num">{num(e.count)}</td>
                  <td className="num">{num(e.participants ?? null)}</td>
                </tr>
              ))}
              {!events.length && (
                <tr>
                  <td colSpan={4} className="muted">
                    Noch keine Ereignisse.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <p className="muted">Stand: {when(stats.data.generated_at)}</p>
    </div>
  )
}

function StudyRow({ row }: { row: StudyStatRow }) {
  const missingFiles = row.videos - row.videos_with_file
  return (
    <tr>
      <td>
        <Link to={`/admin/studies/${row.id}`}>{row.name}</Link>
        <div className="muted small">seit {day(row.created_at)}</div>
      </td>
      <td>{row.is_active ? <Pill tone="ok">aktiv</Pill> : <Pill tone="idle">inaktiv</Pill>}</td>
      <td className="num">
        {num(row.participants)}
        <div className="muted small">{num(row.active)} laufend</div>
      </td>
      <td style={{ minWidth: 120 }}>
        <Meter
          value={row.completion_rate}
          label={`${num(row.completed)}/${num(row.participants)}`}
        />
      </td>
      <td className="num">
        {num(row.videos)}
        {missingFiles > 0 && <div className="warn-text small">{missingFiles} ohne Datei</div>}
      </td>
      <td className="num">{num(row.notes)}</td>
      <td className="num">{num(row.diagnoses)}</td>
      <td className="num">
        {compact(row.gaze_samples)}
        <div className="muted small">{num(row.gaze_recordings)} Aufz.</div>
      </td>
      <td>
        {row.screens_failed ? (
          <Pill tone="bad">{num(row.screens_failed)} fehlgeschlagen</Pill>
        ) : row.screens_stored ? (
          <Pill tone="ok">{num(row.screens_stored)}</Pill>
        ) : (
          <span className="muted">—</span>
        )}
        <div className="muted small">{bytes(row.screen_bytes)}</div>
      </td>
      <td>
        {day(row.last_activity_at)}
        <div className="muted small">Ø {duration((row.avg_session_minutes ?? 0) * 60)}</div>
      </td>
      <td>
        <Link className="btn btn-secondary btn-sm" to={`/admin/studies/${row.id}`}>
          Öffnen
        </Link>
      </td>
    </tr>
  )
}
