import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react'

import { AUTH_STORAGE_KEY } from '../api/client'
import { clearAllDrafts } from '../hooks/useLocalDraft'
import { decodeJwt, isExpired } from '../lib/jwt'
import { queryClient } from '../queryClient'

interface User {
  id: string
  role: string
}

interface AuthValue {
  user: User | null
  login: (token: string) => void
  logout: () => void
}

const AuthContext = createContext<AuthValue | undefined>(undefined)

function readUser(): User | null {
  const raw = localStorage.getItem(AUTH_STORAGE_KEY)
  if (!raw) return null
  try {
    const { token } = JSON.parse(raw) as { token: string }
    const payload = token ? decodeJwt(token) : null
    if (!payload || isExpired(payload) || !payload.sub || !payload.role) return null
    return { id: payload.sub, role: payload.role }
  } catch {
    return null
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(() => readUser())

  const logout = useCallback(() => {
    localStorage.removeItem(AUTH_STORAGE_KEY)
    // The lab machine is shared; unsubmitted text must not outlive the session.
    clearAllDrafts()
    // Nor may the cached queries: `me` and `session` are not keyed by
    // participant, so without this the next person to sign in on this machine
    // is handed the previous one's script — and their step pointer — for as
    // long as the refetch takes.
    queryClient.clear()
    setUser(null)
  }, [])

  const login = useCallback((token: string) => {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify({ token }))
    queryClient.clear()
    setUser(readUser())
  }, [])

  useEffect(() => {
    const onExpired = () => logout()
    window.addEventListener('a04:auth:expired', onExpired)
    return () => window.removeEventListener('a04:auth:expired', onExpired)
  }, [logout])

  const value = useMemo(() => ({ user, login, logout }), [user, login, logout])
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider')
  return ctx
}
