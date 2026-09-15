import { adminApi, EXPORT_KINDS, type ExportKind } from '../../api/admin'
import { useExports } from '../../hooks/admin'

// What each file holds, in the terms the analysis plan uses. A researcher
// downloading `events.csv` for the first time should not have to guess.
const DESCRIPTIONS: Record<ExportKind, string> = {
  participants: 'Eine Zeile je Teilnehmer:in: Status, Video-Set, Fallreihenfolge, Batch-Größe.',
  videos: 'Titel und Phase je Video — der Schlüssel zu jeder video_id in den anderen Dateien.',
  notes: 'Jeder Notiz-Stand mit Playhead-Position (Sekunden und als Zeitangabe).',
  diagnoses: 'Die geschriebene Diagnose je Fall mit der dafür benötigten Zeit.',
  responses: 'Alle Fragebogen-Antworten: Vortest-Seiten, Sicherheitsrating, Fragen nach dem Fall.',
  events: 'Der Interaktions-Log des Fallbildschirms: Play, Pause, Seeks, Notizen, Seitenwechsel.',
  gaze: 'Je Aufzeichnung: Abtastrate und Anzahl der Blickproben.',
  calibration: 'Ergebnis der Eye-Tracker-Kalibrierung, sofern sie in der App stattgefunden hat.',
}

const NOT_COLLECTED =
  'Wird nicht erhoben: die Kalibrierung läuft im Eye Tracker Manager, nicht in dieser App. ' +
  'Zeilen gibt es nur für Durchläufe von vor dieser Umstellung.'

export default function ExportsSection({ studyId }: { studyId: number }) {
  const exports = useExports(studyId)
  const byKind = new Map((exports.data ?? []).map((e) => [e.kind, e]))

  return (
    <div className="card">
      <h2>Exporte (CSV)</h2>
      <p className="muted">
        Alle Rohdaten der Studie als CSV (UTF-8 mit BOM, öffnet direkt in Excel).
      </p>
      <table className="table">
        <thead>
          <tr>
            <th>Datei</th>
            <th>Inhalt</th>
            <th>Zeilen</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {EXPORT_KINDS.map((kind) => {
            const info = byKind.get(kind)
            const empty = info?.rows === 0
            return (
              <tr key={kind}>
                <td>{kind}.csv</td>
                <td>
                  {DESCRIPTIONS[kind]}
                  {info && !info.collected && <div className="small muted">{NOT_COLLECTED}</div>}
                </td>
                <td className="num">
                  {info ? (
                    <span className={empty ? 'pill pill--idle' : 'pill pill--ok'}>{info.rows}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    // Downloadable even when empty: the header alone documents
                    // the columns, and a researcher may want it for a template.
                    onClick={() => void adminApi.downloadExport(studyId, kind)}
                  >
                    Herunterladen
                  </button>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
