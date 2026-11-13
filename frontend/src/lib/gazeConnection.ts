import { TOBII_WS_URL } from './tobii'

export type GazeState =
  | 'connecting'
  | 'bridge_unreachable'
  | 'tracker_missing'
  | 'stream_failed'
  | 'waiting_samples'
  | 'no_samples'
  | 'invalid_samples'
  | 'tracking'
export interface GazeHealth {
  state: GazeState
  received: number
  valid: number
  mock?: boolean
  error_code?: string | null
}

/** A step owns one reconnecting subscription. Bridge status alone never means gaze arrived. */
export function openGazeConnection(options: {
  onHealth: (health: GazeHealth) => void
  onReady: (frequency: unknown, start: () => void) => void
  onSample: (sample: Record<string, unknown>) => void
}) {
  let active = true
  let socket: WebSocket | null = null
  let retryTimer = 0
  let handshakeTimer = 0
  let state: GazeState = 'connecting'
  let received = 0
  let valid = 0
  let lastSample = 0
  let lastValid = 0
  let startedAt = 0
  let attempts = 0
  let ready = false
  let requested = false
  let mock = false

  const publish = (next: GazeState = state, error_code: string | null = null) => {
    state = next
    if (active) options.onHealth({ state, received, valid, mock, error_code })
  }
  const retire = () => {
    window.clearTimeout(handshakeTimer)
    requested = false
    lastSample = lastValid = 0
    const old = socket
    socket = null
    if (!old) return
    old.onmessage = old.onerror = old.onclose = null
    try {
      if (old.readyState === WebSocket.OPEN) old.send(JSON.stringify({ type: 'stop_gaze' }))
      old.close()
    } catch {
      /* an unsuccessful handshake may already be closed */
    }
  }
  const reconnect = (failure: GazeState) => {
    if (!active) return
    publish(failure)
    retire()
    window.clearTimeout(retryTimer)
    retryTimer = window.setTimeout(connect, Math.min(2000 * 2 ** attempts++, 10000))
  }
  const connect = () => {
    if (!active) return
    window.clearTimeout(retryTimer)
    retire()
    ready = false
    requested = false
    startedAt = lastSample = lastValid = 0
    let ws: WebSocket
    try {
      ws = new WebSocket(TOBII_WS_URL)
    } catch {
      reconnect('bridge_unreachable')
      return
    }
    socket = ws
    const current = () => active && socket === ws
    const start = () => {
      if (!current() || requested) return
      try {
        ws.send(JSON.stringify({ type: 'start_gaze' }))
        requested = true
        startedAt = performance.now()
        if (state !== 'tracker_missing') publish('waiting_samples')
      } catch {
        reconnect('bridge_unreachable')
      }
    }
    const trackerReady = (frequency: unknown) => {
      if (!ready) {
        ready = true
        publish('waiting_samples')
        options.onReady(frequency, start)
      }
    }
    handshakeTimer = window.setTimeout(() => {
      if (current()) reconnect('bridge_unreachable')
    }, 5000)
    ws.onerror = ws.onclose = () => {
      if (current()) reconnect('bridge_unreachable')
    }
    ws.onmessage = (event) => {
      if (!current()) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(event.data as string)
      } catch {
        return
      }
      if (!msg || typeof msg !== 'object') return
      if (msg.type === 'status') {
        window.clearTimeout(handshakeTimer)
        mock = msg.source_mode === 'mock'
        if (msg.connected === true) trackerReady(msg.frequency)
        else {
          publish('tracker_missing')
          // New bridges rediscover hardware on demand. Legacy ones are re-probed below.
          start()
        }
        return
      }
      if (msg.type === 'gaze_status') {
        if (msg.connected === true) trackerReady(msg.frequency)
        if (
          ['sdk_unavailable', 'discovery_failed', 'tracker_missing'].includes(
            String(msg.error_code),
          )
        ) {
          publish('tracker_missing', String(msg.error_code))
        } else if (
          ['subscription_failed', 'stream_failed'].includes(String(msg.error_code)) ||
          msg.state === 'error'
        ) {
          publish(
            'stream_failed',
            ['subscription_failed', 'stream_failed'].includes(String(msg.error_code))
              ? String(msg.error_code)
              : null,
          )
        } else if (msg.state === 'no_samples' || msg.error_code === 'no_samples') {
          publish('no_samples', 'no_samples')
        }
        // 'streaming' and bridge-wide counts cannot establish this client's reception.
        return
      }
      if (msg.type !== 'gaze' || !Number.isFinite(msg.ts) || !requested) return
      received++
      lastSample = performance.now()
      const validEye =
        (msg.lv === true && Number.isFinite(msg.lx) && Number.isFinite(msg.ly)) ||
        (msg.rv === true && Number.isFinite(msg.rx) && Number.isFinite(msg.ry))
      if (validEye) {
        valid++
        lastValid = lastSample
      }
      attempts = 0
      options.onSample(msg)
      if (validEye && state !== 'tracking') publish('tracking')
      else if (received === 1) publish('invalid_samples')
    }
  }
  const watchdog = window.setInterval(() => {
    if (!active) return
    if (requested && performance.now() - (lastSample || startedAt) > 5000) {
      reconnect(state === 'tracker_missing' ? 'tracker_missing' : 'no_samples')
      return
    }
    if (
      requested &&
      lastSample &&
      !['tracker_missing', 'stream_failed', 'no_samples'].includes(state)
    )
      publish(
        performance.now() - lastSample > 3000
          ? 'no_samples'
          : performance.now() - lastValid < 3000 && valid > 0
            ? 'tracking'
            : 'invalid_samples',
      )
  }, 1000)
  publish('connecting')
  connect()
  return {
    retry: () => {
      attempts = 0
      publish('connecting')
      connect()
    },
    close: () => {
      active = false
      window.clearTimeout(retryTimer)
      window.clearInterval(watchdog)
      retire()
    },
  }
}
