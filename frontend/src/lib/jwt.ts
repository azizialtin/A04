export interface JwtPayload {
  sub?: string
  role?: string
  exp?: number
}

export function decodeJwt(token: string): JwtPayload | null {
  const part = token.split('.')[1]
  if (!part) return null
  try {
    const json = atob(part.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as JwtPayload
  } catch {
    return null
  }
}

export function isExpired(payload: JwtPayload): boolean {
  return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()
}
