import { useEffect, useRef, useState } from 'react'

const POLL_MS = 250

/**
 * Counts down from `seconds` and calls onExpire exactly once at zero.
 *
 * The remaining time is read from a fixed deadline rather than decremented on
 * a tick: chained timers accumulate their own latency, and a backgrounded tab
 * stretches every hop. The time limit is a variable in the study, so the clock
 * on screen has to be the real one.
 */
export default function Timer({ seconds, onExpire }: { seconds: number; onExpire: () => void }) {
  const [remaining, setRemaining] = useState(seconds)
  const fired = useRef(false)
  const expireRef = useRef(onExpire)
  expireRef.current = onExpire

  useEffect(() => {
    const deadline = Date.now() + seconds * 1000
    fired.current = false

    let poll = 0
    const tick = () => {
      const left = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
      setRemaining(left)
      if (left > 0 || fired.current) return
      fired.current = true
      window.clearInterval(poll)
      expireRef.current()
    }

    poll = window.setInterval(tick, POLL_MS)
    // A tab that was throttled while hidden catches up the moment it is back.
    document.addEventListener('visibilitychange', tick)
    tick()

    return () => {
      window.clearInterval(poll)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [seconds])

  const mm = String(Math.floor(remaining / 60)).padStart(2, '0')
  const ss = String(remaining % 60).padStart(2, '0')
  return (
    <div className="timer" role="timer">
      {`${mm}:${ss}`}
    </div>
  )
}
