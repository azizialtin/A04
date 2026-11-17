import { TOBII_WS_URL } from './tobii'

/** Unsupported browsers retain generic connection help; never infer a denial. */
export async function queryLoopbackPermission(): Promise<PermissionStatus | null> {
  try {
    // Use the granular permission. Older browsers keep generic guidance and
    // show their own prompt when the operator explicitly retries the request.
    return await navigator.permissions.query({
      name: 'loopback-network',
    } as unknown as PermissionDescriptor)
  } catch {
    return null
  }
}

export function observeLoopbackPermission(
  onChange: (state: PermissionState | null) => void,
): () => void {
  let active = true
  let observed: PermissionStatus | null = null
  const update = () => {
    if (active) onChange(observed?.state ?? null)
  }
  void queryLoopbackPermission().then((status) => {
    if (!active) return
    observed = status
    observed?.addEventListener('change', update)
    update()
  })
  return () => {
    active = false
    observed?.removeEventListener('change', update)
  }
}

/** Trigger browser permission from an explicit click; a response is not a health check. */
export async function requestBridgePermission(
  signal: AbortSignal,
  websocketUrl = TOBII_WS_URL,
): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError')
  const endpoint = new URL(websocketUrl)
  if (
    !['ws:', 'wss:'].includes(endpoint.protocol) ||
    !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) ||
    endpoint.username ||
    endpoint.password
  )
    throw new TypeError('The bridge permission request requires a loopback WebSocket endpoint.')
  endpoint.protocol = endpoint.protocol === 'wss:' ? 'https:' : 'http:'
  endpoint.hash = ''
  const options: RequestInit & { targetAddressSpace: 'loopback' } = {
    method: 'GET',
    mode: 'no-cors',
    credentials: 'omit',
    // Fetch requires redirect:'follow' with no-cors. The configured loopback
    // bridge responds directly with 426; CSP still restricts connect targets.
    redirect: 'follow',
    cache: 'no-store',
    targetAddressSpace: 'loopback',
    signal,
  }
  // Start before the first await so the browser sees the user's activation.
  // A WebSocket-only bridge returns HTTP 426; that still triggers permission.
  // Only the subsequent WebSocket status can establish bridge connectivity.
  await fetch(endpoint.href, options)
}
