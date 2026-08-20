import axios, { AxiosError } from 'axios'

const STORAGE_KEY = 'a04_auth'

const apiClient = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8030',
  timeout: 30_000,
})

apiClient.interceptors.request.use((config) => {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw) {
    try {
      const { token } = JSON.parse(raw) as { token: string }
      if (token) config.headers.Authorization = `Bearer ${token}`
    } catch {
      /* malformed entry — ignore */
    }
  }
  return config
})

apiClient.interceptors.response.use(
  (res) => res,
  (err: AxiosError) => {
    if (err.response?.status === 401) {
      // The auth layer decides what to do; keep the API layer router-agnostic.
      window.dispatchEvent(new Event('a04:auth:expired'))
    }
    return Promise.reject(err)
  },
)

export const AUTH_STORAGE_KEY = STORAGE_KEY
export default apiClient
