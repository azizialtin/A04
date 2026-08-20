import { useAudit } from '../../hooks/admin'

export default function AdminAuditPage() {
  const audit = useAudit()

  return (
    <div>
      <h1>Audit-Log</h1>
      {audit.isLoading ? (
        <p className="muted">Wird geladen…</p>
      ) : (
        <table className="table">
          <thead>
            <tr>
              <th>Zeit</th>
              <th>Akteur</th>
              <th>Aktion</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {(audit.data ?? []).map((a) => (
              <tr key={a.id}>
                <td>{new Date(a.created_at).toLocaleString()}</td>
                <td>{a.actor_email ?? '—'}</td>
                <td>{a.action}</td>
                <td className="muted">{JSON.stringify(a.meta)}</td>
              </tr>
            ))}
            {audit.data?.length === 0 && (
              <tr>
                <td colSpan={4} className="muted">
                  Noch keine Einträge.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  )
}
