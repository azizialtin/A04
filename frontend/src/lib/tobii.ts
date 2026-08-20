// The lab machine's Tobii bridge. Override per machine with VITE_TOBII_WS_URL.
export const TOBII_WS_URL =
  (import.meta.env.VITE_TOBII_WS_URL as string | undefined) ?? 'ws://localhost:8765'

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
          resolve(
            new Bridge(ws, {
              connected: !!msg.connected,
              frequency: Number(msg.frequency) || 0,
              display_w_mm: msg.display_w_mm ?? null,
              display_h_mm: msg.display_h_mm ?? null,
            }),
          )
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
    if (msg.type === 'gaze') {
      this.onGaze?.({
        x: typeof msg.lx === 'number' ? msg.lx : null,
        y: typeof msg.ly === 'number' ? msg.ly : null,
        dz: typeof msg.dz === 'number' ? msg.dz : null,
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
    try {
      this.ws.close()
    } catch {
      /* already gone */
    }
  }
}
