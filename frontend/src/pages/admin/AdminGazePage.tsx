import { useState } from 'react'

import type { ReplayRef, ScreenSummary } from '../../api/admin'
import AdminReplayViewer from '../../components/admin/AdminReplayViewer'
import ParticipantStatsPanel from '../../components/admin/ParticipantStatsPanel'
import { useGazeRecordings, useReplay } from '../../hooks/admin'

function screenLabel(screen: ScreenSummary | null): string {
  if (!screen) return '—'
  if (screen.status === 'failed') return 'fehlgeschlagen'
  // Still "recording" long after the case means the upload never arrived.
  if (screen.status !== 'stored') return 'läuft…'
  const minutes = screen.duration_ms ? Math.round(screen.duration_ms / 60000) : null
  const mb = screen.byte_size ? Math.round(screen.byte_size / 1024 / 1024) : null
  // Worth a word: a browser capture means no bridge was running for that case.
  const who = screen.recorder === 'browser' ? 'Browser' : null
  return (
    [minutes ? `${minutes} min` : null, mb ? `${mb} MB` : null, who].filter(Boolean).join(' · ') ||
    'ok'
  )
}

export default function AdminGazePage() {
  const recordings = useGazeRecordings()
  const [selected, setSelected] = useState<ReplayRef | null>(null)
  const [inspected, setInspected] = useState<string | null>(null)
  const replay = useReplay(selected)

  return (
    <div>
      <h1>Aufzeichnungen</h1>
      {recordings.isLoading ? (
        <p className="muted">Wird geladen…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Teilnehmer</th>
              <th>Bildschirm / Video</th>
              <th>Samples</th>
              <th>Hz</th>
              <th>Bildschirm</th>
              <th>Beginn</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(recordings.data ?? []).map((r) => (
              <tr key={`${r.replay.kind}-${r.replay.id}`}>
                <td>
                  <button
                    type="button"
                    className="btn btn-ghost btn-sm"
                    onClick={() => setInspected(r.participant_id)}
                  >
                    {r.participant_id}
                  </button>
                </td>
                <td>
                  {r.questionnaire_title || r.video_title || 'Fragebogen'}
                  {r.step_kind && r.step_kind !== 'case_video' && (
                    <div className="muted small">
                      {r.step_kind === 'diagnosis'
                        ? 'Diagnose'
                        : r.step_kind === 'case_outro'
                          ? 'Nach dem Fall'
                          : 'Fragebogen'}
                    </div>
                  )}
                </td>
                <td>{r.replay.kind === 'gaze' ? r.sample_count : '—'}</td>
                <td>{r.sampling_rate_hz || '—'}</td>
                <td title={r.screen?.error ?? undefined}>{screenLabel(r.screen)}</td>
                <td>{new Date(r.started_at).toLocaleString()}</td>
                <td>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    // A stored capture is worth watching even with no gaze on it.
                    disabled={
                      r.replay_available === false ||
                      (r.sample_count === 0 && r.screen?.status !== 'stored')
                    }
                    onClick={() => setSelected(r.replay)}
                  >
                    Replay
                  </button>
                </td>
              </tr>
            ))}
            {recordings.data?.length === 0 && (
              <tr>
                <td colSpan={7} className="muted">
                  Noch keine Aufzeichnungen.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}

      {inspected && (
        <ParticipantStatsPanel participantId={inspected} onClose={() => setInspected(null)} />
      )}

      {selected != null && replay.isLoading && <p className="muted">Replay wird geladen…</p>}
      {selected != null && replay.data && (
        <AdminReplayViewer replay={replay.data} onClose={() => setSelected(null)} />
      )}
    </div>
  )
}
