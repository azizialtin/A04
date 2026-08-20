import { adminApi, EXPORT_KINDS } from '../../api/admin'

export default function ExportsSection({ studyId }: { studyId: number }) {
  return (
    <div className="card">
      <h2>Exporte (CSV)</h2>
      <p className="muted">Alle Rohdaten der Studie als CSV.</p>
      <div className="inline-form">
        {EXPORT_KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            className="btn btn-secondary"
            onClick={() => void adminApi.downloadExport(studyId, kind)}
          >
            {kind}.csv
          </button>
        ))}
      </div>
    </div>
  )
}
