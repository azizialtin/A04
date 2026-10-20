import { useEffect, useMemo, useState } from 'react'

import { adminApi, EXPORT_KINDS, type ExportKind } from '../../api/admin'
import { useExports, useParticipants } from '../../hooks/admin'

// What each file holds, in the terms the analysis plan uses. A researcher
// downloading `events.csv` for the first time should not have to guess.
const DESCRIPTIONS: Record<ExportKind, string> = {
  participants: 'Eine Zeile je Teilnehmer:in: Status, Video-Set, Fallreihenfolge, Batch-Größe.',
  videos: 'Titel und Phase je Video — der Schlüssel zu jeder video_id in den anderen Dateien.',
  notes: 'Jeder Notiz-Stand mit Playhead-Position (Sekunden und als Zeitangabe).',
  diagnoses: 'Die geschriebene Diagnose je Fall mit der dafür benötigten Zeit.',
  responses: 'Alle Fragebogen-Antworten: Vortest-Seiten, Sicherheitsrating, Fragen nach dem Fall.',
  sections:
    'Zeit je Abschnitt und Person — die Tabelle „Fragebögen“ im Teilnehmer-Panel: alle Seiten ' +
    'eines Abschnitts addiert, dazu der Vortest gesamt.',
  events: 'Der Interaktions-Log des Fallbildschirms: Play, Pause, Seeks, Notizen, Seitenwechsel.',
  gaze:
    'Jede rohe Blickprobe mit Zeitstempel, Gültigkeit, Bildschirm, Fragebogen und AOI. ' +
    'Die Zeilenzahl entspricht den gespeicherten Probenzählern; der Download prüft die Dateien.',
  gaze_recordings:
    'Je Aufzeichnung: Bildschirm, Fragebogen, Abtastrate und Anzahl der Blickproben.',
  calibration: 'Ergebnis der Eye-Tracker-Kalibrierung, sofern sie in der App stattgefunden hat.',
}

const NOT_COLLECTED =
  'Wird nicht erhoben: die Kalibrierung läuft im Eye Tracker Manager, nicht in dieser App. ' +
  'Zeilen gibt es nur für Durchläufe von vor dieser Umstellung.'

interface Props {
  studyId: number
  /** A participant to start with as the only one chosen — the "Export" shortcut
   *  on the participant list lands here. Null starts with everyone. */
  preselected?: string | null
}

export default function ExportsSection({ studyId, preselected = null }: Props) {
  const participants = useParticipants(studyId)
  const ids = useMemo(() => (participants.data ?? []).map((p) => p.id), [participants.data])

  // Who is left *out*. Everyone is in by default, so a person added after this
  // tab was opened is included without anyone having to notice — the whole
  // study is the common case, and it must not quietly lose a row.
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [appliedFor, setAppliedFor] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [downloadError, setDownloadError] = useState('')
  const [downloading, setDownloading] = useState<ExportKind | null>(null)

  useEffect(() => {
    if (!preselected || preselected === appliedFor || !ids.includes(preselected)) return
    setExcluded(new Set(ids.filter((id) => id !== preselected)))
    setAppliedFor(preselected)
  }, [preselected, appliedFor, ids])

  const chosen = ids.filter((id) => !excluded.has(id))
  // Absent means the whole study, which is also what keeps the filenames plain.
  const filter = excluded.size === 0 ? undefined : chosen
  const nobody = ids.length > 0 && chosen.length === 0

  const exports = useExports(studyId, filter)
  const byKind = new Map((exports.data ?? []).map((e) => [e.kind, e]))

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const needle = search.trim().toLowerCase()
  const shown = needle ? ids.filter((id) => id.toLowerCase().includes(needle)) : ids

  const download = async (kind: ExportKind) => {
    setDownloadError('')
    setDownloading(kind)
    try {
      await adminApi.downloadExport(studyId, kind, filter)
    } catch {
      setDownloadError(
        'Download fehlgeschlagen. Bitte erneut versuchen. Wenn der Fehler bleibt, ' +
          'muss das Studienteam die gespeicherten Aufzeichnungen prüfen.',
      )
    } finally {
      setDownloading(null)
    }
  }

  return (
    <div className="card">
      <h2>Exporte (CSV)</h2>
      {downloadError && (
        <p className="error-text" role="alert">
          {downloadError}
        </p>
      )}
      <p className="muted">
        Alle Rohdaten der Studie als CSV (UTF-8 mit BOM, öffnet direkt in Excel). Jede Zeile mit
        Fallbezug trägt neben der video_id auch case_number (Position des Falls im Durchlauf dieser
        Person), phase_type und video_title.
      </p>

      <h3>Teilnehmer auswählen</h3>
      <p className="muted small">
        Die Dateien enthalten nur die ausgewählten Personen — so lässt sich eine neue Person
        herunterladen, ohne alle anderen erneut zu laden. Bei einer Auswahl trägt der Dateiname die
        ID bzw. „auswahl“.
      </p>
      <div className="inline-form" style={{ marginBottom: 8 }}>
        <span className="pill pill--idle">
          {chosen.length} von {ids.length} ausgewählt
        </span>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setExcluded(new Set())}
          disabled={excluded.size === 0}
        >
          Alle
        </button>
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={() => setExcluded(new Set(ids))}
          disabled={ids.length === 0 || nobody}
        >
          Keine
        </button>
        <input
          className="input"
          style={{ maxWidth: 220 }}
          placeholder="ID filtern…"
          aria-label="Teilnehmer-IDs filtern"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
      </div>
      {ids.length === 0 ? (
        <p className="muted small">Noch keine Teilnehmer in dieser Studie.</p>
      ) : (
        <div className="picker">
          {shown.map((id) => (
            <label key={id}>
              <input type="checkbox" checked={!excluded.has(id)} onChange={() => toggle(id)} />
              <span>{id}</span>
            </label>
          ))}
          {shown.length === 0 && <span className="muted small">Keine ID passt zu „{search}“.</span>}
        </div>
      )}
      {nobody && (
        <p className="error-text" style={{ marginTop: 8 }}>
          Keine Person ausgewählt — es gibt nichts herunterzuladen.
        </p>
      )}

      <table className="table" style={{ marginTop: 16 }}>
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
                <td>{info?.filename ?? `${kind}.csv`}</td>
                <td>
                  {DESCRIPTIONS[kind]}
                  {info && !info.collected && <div className="small muted">{NOT_COLLECTED}</div>}
                </td>
                <td className="num">
                  {info && !nobody ? (
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
                    disabled={nobody || downloading !== null}
                    onClick={() => void download(kind)}
                  >
                    {downloading === kind ? 'Wird vorbereitet…' : 'Herunterladen'}
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
