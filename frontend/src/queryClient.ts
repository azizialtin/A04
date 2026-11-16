import { QueryClient } from '@tanstack/react-query'

export const queryClient = new QueryClient({
  defaultOptions: {
    // Windows may report no Internet while the lab API is still reachable.
    // Let the request succeed or fail instead of silently pausing navigation.
    queries: {
      networkMode: 'always',
      retry: 1,
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
    mutations: { networkMode: 'always', retry: 0 },
  },
})
