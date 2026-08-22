import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'

import type { Study } from '../../api/admin'
import ExportsSection from '../../components/admin/ExportsSection'
import ParticipantsSection from '../../components/admin/ParticipantsSection'
import QuestionnairesSection from '../../components/admin/QuestionnairesSection'
import StatsSection from '../../components/admin/StatsSection'
import VideosSection from '../../components/admin/VideosSection'
import { useStudy, useUpdateStudy } from '../../hooks/admin'

const TABS = [
  ['stats', 'Statistik'],
  ['videos', 'Videos'],
  ['participants', 'Teilnehmer'],
  ['questionnaires', 'Fragebögen'],
  ['export', 'Export'],
  ['details', 'Details'],
] as const

export default function AdminStudyDetailPage() {
  const { studyId } = useParams()
  const id = Number(studyId)
  const study = useStudy(id)
  const [tab, setTab] = useState<string>('stats')

  if (study.isLoading) return <p className="muted">Wird geladen…</p>
  if (study.isError || !study.data) return <p className="error-text">Studie nicht gefunden.</p>

  return (
    <div>
      <Link to="/admin/studies" className="muted">
        ← Studien
      </Link>
      <h1>{study.data.name}</h1>

      <div className="tabs">
        {TABS.map(([key, label]) => (
          <button key={key} type="button" className={tab === key ? 'is-active' : ''} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'stats' && <StatsSection studyId={id} />}
      {tab === 'videos' && <VideosSection studyId={id} />}
      {tab === 'participants' && <ParticipantsSection studyId={id} />}
      {tab === 'questionnaires' && <QuestionnairesSection studyId={id} />}
      {tab === 'export' && <ExportsSection studyId={id} />}
      {tab === 'details' && <DetailsSection study={study.data} />}
    </div>
  )
}

function DetailsSection({ study }: { study: Study }) {
  const update = useUpdateStudy(study.id)
  const [name, setName] = useState(study.name)
  const [pre, setPre] = useState(study.sosci_pretest_url)
  const [post, setPost] = useState(study.sosci_posttest_url)
  const [idParam, setIdParam] = useState(study.sosci_id_param)

  return (
    <div className="card form">
      <h2>Details</h2>
      <div className="form-row">
        <label className="label">Name</label>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">SoSci-Link (Vortest)</label>
        <input className="input" value={pre} onChange={(e) => setPre(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">SoSci-Link (Nachtest)</label>
        <input className="input" value={post} onChange={(e) => setPost(e.target.value)} />
      </div>
      <div className="form-row">
        <label className="label">ID-Parameter</label>
        <input className="input" value={idParam} onChange={(e) => setIdParam(e.target.value)} />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        disabled={update.isPending}
        onClick={() =>
          update.mutate({ name, sosci_pretest_url: pre, sosci_posttest_url: post, sosci_id_param: idParam })
        }
      >
        Speichern
      </button>
      {update.isSuccess && <span className="muted" style={{ marginLeft: 12 }}>Gespeichert.</span>}
    </div>
  )
}
