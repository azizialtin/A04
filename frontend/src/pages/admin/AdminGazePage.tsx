import { useState } from 'react'

import type { ScreenSummary } from '../../api/admin'
import AdminReplayViewer from '../../components/admin/AdminReplayViewer'
import { useGazeRecordings, useGazeReplay } from '../../hooks/admin'

function screenLabel(screen: ScreenSummary | null): string {
  if (!screen) return '—'
  if (screen.status === 'failed') return 'fehlgeschlagen'
  // Still "recording" long after the case means the upload never arrived.
  if (screen.status !== 'stored') return 'läuft…'
  const minutes = screen.duration_ms ? Math.round(screen.duration_ms / 60000) : null
  const mb = screen.byte_size ? Math.round(screen.byte_size / 1024 / 1024) : null
  return [minutes ? `${minutes} min` : null, mb ? `${mb} MB` : null].filter(Boolean).join(' · ') || 'ok'
}

export default function AdminGazePage() {
  const recordings = useGazeRecordings()
  const [selectedId, setSelectedId] = useState<number | null>(null)
  const replay = useGazeReplay(selectedId)

  return (
    <div>
      <h1>Gaze-Aufzeichnungen</h1>
      {recordings.isLoading ? (
        <p className="muted">Wird geladen…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Teilnehmer</th>
              <th>Video</th>
              <th>Samples</th>
              <th>Hz</th>
              <th>Bildschirm</th>
              <th>Beginn</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(recordings.data ?? []).map((r) => (
              <tr key={r.id}>
                <td>{r.id}</td>
                <td>{r.participant_id}</td>
                <td>{r.video_title}</td>
                <td>{r.sample_count}</td>
                <td>{r.sampling_rate_hz}</td>
                <td title={r.screen?.error ?? undefined}>{screenLabel(r.screen)}</td>
                <td>{new Date(r.started_at).toLocaleString()}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    // A stored capture is worth watching even with no gaze on it.
                    disabled={r.sample_count === 0 && r.screen?.status !== 'stored'}
                    onClick={() => setSelectedId(r.id)}
                  >
                    Replay
                  </button>
                </td>
              </tr>
            ))}
            {recordings.data?.length === 0 && (
              <tr>
                <td colSpan={8} className="muted">
                  Noch keine Aufzeichnungen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {selectedId != null && replay.isLoading && <p className="muted">Replay wird geladen…</p>}
      {selectedId != null && replay.data && (
        <AdminReplayViewer replay={replay.data} onClose={() => setSelectedId(null)} />
      )}
    </div>
  )
}
