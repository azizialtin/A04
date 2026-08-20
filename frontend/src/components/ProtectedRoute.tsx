import type { ReactNode } from 'react'
import { Navigate } from 'react-router-dom'

import { useAuth } from '../contexts/AuthContext'

export default function ProtectedRoute({
  requiredRole,
  children,
}: {
  requiredRole: 'participant' | 'admin'
  children: ReactNode
}) {
  const { user } = useAuth()
  if (!user) return <Navigate to={requiredRole === 'admin' ? '/admin/login' : '/login'} replace />
  if (user.role !== requiredRole) return <Navigate to="/" replace />
  return <>{children}</>
}
