import { NavLink, Navigate, Route, Routes } from 'react-router-dom'

import { useAuth } from '../contexts/AuthContext'
import AdminAuditPage from './admin/AdminAuditPage'
import AdminGazePage from './admin/AdminGazePage'
import AdminOverviewPage from './admin/AdminOverviewPage'
import AdminStudyDetailPage from './admin/AdminStudyDetailPage'
import AdminStudyListPage from './admin/AdminStudyListPage'

function link({ isActive }: { isActive: boolean }) {
  return `admin__link${isActive ? ' is-active' : ''}`
}

export default function AdminDashboardPage() {
  const { logout } = useAuth()
  return (
    <div className="admin">
      <aside className="admin__nav">
        <div className="admin__brand">A04 · Admin</div>
        <NavLink to="/admin/overview" className={link}>
          Übersicht
        </NavLink>
        <NavLink to="/admin/studies" className={link}>
          Studien
        </NavLink>
        <NavLink to="/admin/gaze" className={link}>
          Aufzeichnungen
        </NavLink>
        <NavLink to="/admin/audit" className={link}>
          Audit-Log
        </NavLink>
        <button type="button" className="btn btn-ghost admin__logout" onClick={logout}>
          Abmelden
        </button>
      </aside>
      <main className="admin__main">
        <Routes>
          <Route index element={<Navigate to="/admin/overview" replace />} />
          <Route path="overview" element={<AdminOverviewPage />} />
          <Route path="studies" element={<AdminStudyListPage />} />
          <Route path="studies/:studyId" element={<AdminStudyDetailPage />} />
          <Route path="gaze" element={<AdminGazePage />} />
          <Route path="audit" element={<AdminAuditPage />} />
          <Route path="*" element={<Navigate to="/admin/overview" replace />} />
        </Routes>
      </main>
    </div>
  )
}
