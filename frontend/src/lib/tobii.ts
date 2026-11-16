// The lab machine's Tobii bridge. Override per machine with VITE_TOBII_WS_URL.
export const TOBII_WS_URL =
  (import.meta.env.VITE_TOBII_WS_URL as string | undefined) ?? 'ws://127.0.0.1:8766'

export interface BridgeStatus {
  connected: boolean
  frequency: number
  display_w_mm: number | null
  display_h_mm: number | null
}

export interface BridgeGaze {
  x: number | null
  y: number | null
  dz: number | null
}

const DEFAULT_TIMEOUT_MS = 15_000

function readStatus(msg: Record<string, unknown>): BridgeStatus {
  const positive = (value: unknown) =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null
  return {
    connected: msg.connected === true,
    frequency: positive(msg.frequency) ?? 0,
    display_w_mm: positive(msg.display_w_mm),
    display_h_mm: positive(msg.display_h_mm),
  }
}

/**
 * Request/response wrapper over the bridge socket, for the calibration
 * exchange. The gaze stream stays a callback — it is a firehose, not a reply.
 *
 * The streaming capture path deliberately does not use this: it wants a socket
 * it can open, forget, and drop on unmount.
 */
export class Bridge {
  private pending = new Map<string, (msg: Record<string, unknown>) => void>()

  private constructor(
    private ws: WebSocket,
    readonly status: BridgeStatus,
  ) {
    ws.onmessage = (event) => this.dispatch(event)
  }

  onGaze: ((sample: BridgeGaze) => void) | null = null
  onStatus: ((status: BridgeStatus) => void) | null = null

  static connect(url: string, timeoutMs = 5000): Promise<Bridge> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket
      try {
        ws = new WebSocket(url)
      } catch (err) {
        reject(err)
        return
      }

      const timer = window.setTimeout(() => {
        ws.close()
        reject(new Error('The eye-tracker bridge did not answer.'))
      }, timeoutMs)

      ws.onerror = () => {
        window.clearTimeout(timer)
        reject(new Error('Could not reach the eye-tracker bridge.'))
      }
      // The bridge announces itself; that first message is the handshake.
      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string)
          if (msg.type !== 'status') return
          window.clearTimeout(timer)
          resolve(new Bridge(ws, readStatus(msg)))
        } catch {
          /* ignore malformed frame */
        }
      }
    })
  }

  private dispatch(event: MessageEvent) {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(event.data as string)
    } catch {
      return
    }
    if (msg.type === 'status') {
      Object.assign(this.status, readStatus(msg))
      this.onStatus?.(this.status)
      return
    }
    if (msg.type === 'gaze') {
      const eyes = [
        { valid: msg.lv, x: msg.lx, y: msg.ly },
        { valid: msg.rv, x: msg.rx, y: msg.ry },
      ].filter(
        (eye): eye is { valid: true; x: number; y: number } =>
          eye.valid === true &&
          typeof eye.x === 'number' &&
          Number.isFinite(eye.x) &&
          typeof eye.y === 'number' &&
          Number.isFinite(eye.y),
      )
      this.onGaze?.({
        x: eyes.length ? eyes.reduce((sum, eye) => sum + eye.x, 0) / eyes.length : null,
        y: eyes.length ? eyes.reduce((sum, eye) => sum + eye.y, 0) / eyes.length : null,
        dz: typeof msg.dz === 'number' && Number.isFinite(msg.dz) && msg.dz > 0 ? msg.dz : null,
      })
      return
    }
    const waiter = this.pending.get(String(msg.type))
    if (waiter) {
      this.pending.delete(String(msg.type))
      waiter(msg)
    }
  }

  send(type: string, payload: Record<string, unknown> = {}) {
    if (this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type, ...payload }))
    }
  }

  /** Send `type` and wait for `reply`. */
  request(
    type: string,
    reply: string,
    payload: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(reply)
        reject(new Error(`The eye tracker did not answer "${type}".`))
      }, timeoutMs)
      this.pending.set(reply, (msg) => {
        window.clearTimeout(timer)
        resolve(msg)
      })
      this.send(type, payload)
    })
  }

  close() {
    this.pending.clear()
    this.onGaze = null
    this.onStatus = null
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}
