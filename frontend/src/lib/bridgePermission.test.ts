import { afterEach, expect, test, vi } from 'vitest'
import {
  observeLoopbackPermission,
  queryLoopbackPermission,
  requestBridgePermission,
} from './bridgePermission'

const permissionsDescriptor = Object.getOwnPropertyDescriptor(navigator, 'permissions')
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  if (permissionsDescriptor) Object.defineProperty(navigator, 'permissions', permissionsDescriptor)
  else Reflect.deleteProperty(navigator, 'permissions')
})
function permissions(query: unknown) {
  Object.defineProperty(navigator, 'permissions', { configurable: true, value: { query } })
}
function status(state: PermissionState) {
  return Object.assign(new EventTarget(), { state }) as PermissionStatus
}

test.each(['granted', 'denied', 'prompt'] as const)(
  'queries the granular permission without overriding %s with an alias',
  async (state) => {
    const current = status(state)
    const query = vi.fn().mockResolvedValue(current)
    permissions(query)
    expect(await queryLoopbackPermission()).toBe(current)
    expect(query).toHaveBeenCalledExactlyOnceWith({ name: 'loopback-network' })
  },
)

test('unsupported and absent APIs return unknown without querying a legacy alias', async () => {
  const query = vi.fn().mockRejectedValue(new TypeError('Unsupported permission'))
  permissions(query)
  expect(await queryLoopbackPermission()).toBeNull()
  expect(query).toHaveBeenCalledTimes(1)
  Reflect.deleteProperty(navigator, 'permissions')
  expect(await queryLoopbackPermission()).toBeNull()
})

test('observes permission changes and removes its listener on cleanup', async () => {
  const current = status('denied')
  permissions(vi.fn().mockResolvedValue(current))
  const change = vi.fn()
  const remove = vi.spyOn(current, 'removeEventListener')
  const stop = observeLoopbackPermission(change)
  await vi.waitFor(() => expect(change).toHaveBeenCalledWith('denied'))
  Object.assign(current, { state: 'granted' })
  current.dispatchEvent(new Event('change'))
  expect(change).toHaveBeenLastCalledWith('granted')
  stop()
  expect(remove).toHaveBeenCalledWith('change', expect.any(Function))
  current.dispatchEvent(new Event('change'))
  expect(change).toHaveBeenCalledTimes(2)
})

test('cleanup before the asynchronous query resolves prevents stale updates', async () => {
  let complete!: (value: PermissionStatus) => void
  permissions(vi.fn(() => new Promise<PermissionStatus>((resolve) => (complete = resolve))))
  const change = vi.fn()
  const stop = observeLoopbackPermission(change)
  stop()
  const current = status('denied')
  const add = vi.spyOn(current, 'addEventListener')
  complete(current)
  await Promise.resolve()
  await Promise.resolve()
  expect(change).not.toHaveBeenCalled()
  expect(add).not.toHaveBeenCalled()
})

test('an unsupported permission observation reports unknown', async () => {
  permissions(vi.fn().mockRejectedValue(new TypeError('Unsupported permission')))
  const change = vi.fn()
  const stop = observeLoopbackPermission(change)
  await vi.waitFor(() => expect(change).toHaveBeenCalledExactlyOnceWith(null))
  stop()
})

test('starts the permission request immediately and never interprets HTTP 426 as bridge health', async () => {
  const fetch = vi.fn().mockResolvedValue(new Response('WebSocket required', { status: 426 }))
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  const requested = requestBridgePermission(controller.signal)
  expect(fetch).toHaveBeenCalledExactlyOnceWith('http://127.0.0.1:8766/', {
    method: 'GET',
    mode: 'no-cors',
    credentials: 'omit',
    redirect: 'follow',
    cache: 'no-store',
    targetAddressSpace: 'loopback',
    signal: controller.signal,
  })
  await expect(requested).resolves.toBeUndefined()
})

test.each([
  ['ws://localhost:8766/', 'http://localhost:8766/'],
  ['ws://[::1]:8766/', 'http://[::1]:8766/'],
  ['wss://127.0.0.1:8766/bridge', 'https://127.0.0.1:8766/bridge'],
])('preserves the configured loopback endpoint %s', async (websocket, endpoint) => {
  const fetch = vi.fn().mockResolvedValue({ type: 'opaque' })
  vi.stubGlobal('fetch', fetch)
  await requestBridgePermission(new AbortController().signal, websocket)
  expect(fetch).toHaveBeenCalledWith(endpoint, expect.objectContaining({ redirect: 'follow' }))
})

test.each([
  'ws://example.org:8766',
  'ws://192.168.1.10:8766',
  'ws://127.0.0.1.example.org:8766',
  'http://127.0.0.1:8766',
  'ws://user:secret@127.0.0.1:8766',
  'not-a-url',
])('never sends a permission request to unsupported endpoint %s', async (endpoint) => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  await expect(requestBridgePermission(new AbortController().signal, endpoint)).rejects.toThrow()
  expect(fetch).not.toHaveBeenCalled()
})

test('an already aborted request does not contact the bridge', async () => {
  const fetch = vi.fn()
  vi.stubGlobal('fetch', fetch)
  const controller = new AbortController()
  controller.abort()
  await expect(requestBridgePermission(controller.signal)).rejects.toMatchObject({
    name: 'AbortError',
  })
  expect(fetch).not.toHaveBeenCalled()
})

test('propagates cancellation during a permission prompt to fetch', async () => {
  const controller = new AbortController()
  const fetch = vi.fn(
    (_url, options: RequestInit) =>
      new Promise((_resolve, reject) => {
        options.signal?.addEventListener('abort', () => reject(options.signal?.reason), {
          once: true,
        })
      }),
  )
  vi.stubGlobal('fetch', fetch)
  const requested = requestBridgePermission(controller.signal)
  controller.abort()
  await expect(requested).rejects.toMatchObject({ name: 'AbortError' })
})

test('a denied or unreachable network request is not reported as a successful connection', async () => {
  const failure = new TypeError('Failed to fetch')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
  await expect(requestBridgePermission(new AbortController().signal)).rejects.toBe(failure)
})
