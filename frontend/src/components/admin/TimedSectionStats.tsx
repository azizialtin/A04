import type { ParticipantTimedSection } from '../../api/admin'
import { duration, num } from '../../lib/adminFormat'
import { Facts, Pill } from './stat'

function timestamp(value: number | null): string {
  return value == null ? '—' : new Date(value).toLocaleString('de-DE')
}

function exitLabel(reason: string | null): string {
  switch (reason) {
    case 'completed':
      return 'Regulär abgeschlossen'
    case 'submitted':
      return 'Abgegeben'
    case 'supervisor_finish':
      return 'Teilantwort gespeichert'
    case 'step_back':
      return 'Zurück durch Betreuung'
    default:
      return reason ?? 'Kein Austritt erfasst'
  }
}

function answerText(value: unknown): string {
  if (value == null) return '—'
  if (Array.isArray(value)) return value.length ? value.map(answerText).join(', ') : '—'
  if (typeof value === 'object') {
    return Object.entries(value)
      .map(([key, entry]) => {
        const label = key === 'lines' ? 'Zeilen' : key === 'explanation' ? 'Erklärung' : key
        return `${label}: ${answerText(entry)}`
      })
      .join('\n')
  }
  return String(value) || '—'
}

export default function TimedSectionStats({ rows }: { rows: ParticipantTimedSection[] }) {
  return (
    <>
      <h4 className="section-head">Abschnittszeiten</h4>
      {!rows.length && <p className="muted">Keine Abschnittszeitmessung erfasst.</p>}
      {rows.map((section) => (
        <section
          className="case-card"
          aria-label={`Zeitmessung ${section.section}`}
          key={section.section_key}
        >
          <header className="case-card__head">
            <strong>{section.section}</strong>
            <Pill tone={section.ended_client_ts == null ? 'idle' : 'ok'}>
              {section.ended_client_ts == null
                ? 'Kein Ende erfasst'
                : section.exit_reason === 'supervisor_finish'
                  ? 'Durch Betreuung beendet'
                  : exitLabel(section.exit_reason)}
            </Pill>
          </header>
          <Facts
            rows={[
              ['Beginn', timestamp(section.started_client_ts)],
              ['Ende', timestamp(section.ended_client_ts)],
              ['Dauer (Beginn bis Ende)', duration(section.elapsed_seconds)],
              ['Timer-Ende (Serverzeit)', timestamp(section.deadline_ms)],
              ['Überziehung (über 7 Minuten)', duration(section.deadline_overrun_seconds)],
              ['Besuchte Seiten', num(section.visited_pages)],
            ]}
          />
          <p className="muted small">
            Beginn und Ende stammen vom Teilnehmergerät. Die Einführung zählt nicht mit;
            Überarbeitungen ändern die ursprüngliche Abschnittszeit und Seitenzahl nicht. Ohne
            erfasstes Ende bleibt die Dauer offen.
          </p>
          <details>
            <summary style={{ cursor: 'pointer', padding: '8px 0' }}>
              Seitenbesuche ({num(section.page_visits?.length ?? 0)})
            </summary>
            <div className="table-scroll">
              <table className="table" aria-label={`Seitenbesuche ${section.section}`}>
                <thead>
                  <tr>
                    <th>Seite</th>
                    <th>Modus</th>
                    <th>Eintritt</th>
                    <th>Austritt</th>
                    <th className="num">Dauer</th>
                    <th>Abschluss</th>
                    <th>Antwortstand</th>
                  </tr>
                </thead>
                <tbody>
                  {(section.page_visits ?? []).map((visit) => (
                    <tr key={visit.visit_id}>
                      <td>{visit.title}</td>
                      <td>
                        <Pill tone={visit.is_review ? 'warn' : 'idle'}>
                          {visit.is_review ? 'Überarbeitung' : 'Erstbearbeitung'}
                        </Pill>
                      </td>
                      <td>{timestamp(visit.entered_client_ts)}</td>
                      <td>{timestamp(visit.exited_client_ts)}</td>
                      <td className="num">{duration(visit.elapsed_seconds)}</td>
                      <td>{exitLabel(visit.exit_reason)}</td>
                      <td>
                        {visit.submitted_answers == null ? (
                          <span className="muted">Kein Antwortstand erfasst</span>
                        ) : (
                          <details>
                            <summary style={{ cursor: 'pointer', padding: '8px 0' }}>
                              Antwortstand anzeigen
                            </summary>
                            {Object.keys(visit.submitted_answers).length ? (
                              <dl>
                                {Object.entries(visit.submitted_answers).map(([id, answer]) => (
                                  <div key={id}>
                                    <dt>{id}</dt>
                                    <dd
                                      style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
                                    >
                                      {answerText(answer)}
                                    </dd>
                                  </div>
                                ))}
                              </dl>
                            ) : (
                              <p className="muted">Leerer Antwortstand</p>
                            )}
                          </details>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!section.page_visits?.length && (
                    <tr>
                      <td colSpan={7} className="muted">
                        Keine Seitenbesuche erfasst.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <p className="muted small">
              Antwortstände gehören zum jeweiligen Besuch. Nicht besuchte Seiten werden nicht
              aufgeführt. Ein fehlender Austritt bleibt unbekannt, auch nach einem späteren Besuch.
            </p>
          </details>
        </section>
      ))}
    </>
  )
}
