import { describe, expect, test } from 'vitest'

import {
  DisplayGuardController,
  displayProblems,
  type DisplayGuardEvent,
  type DisplayMetrics,
} from './displayGuard'

const lab: DisplayMetrics = {
  screenWidth: 1920,
  screenHeight: 1080,
  innerWidth: 1920,
  innerHeight: 1080,
  outerWidth: 1920,
  outerHeight: 1080,
  x: 0,
  y: 0,
  dpr: 1,
  extended: false,
  visible: true,
  focused: true,
  viewport: { scale: 1, x: 0, y: 0 },
}

function setup(enabled = true) {
  let now = 100_000
  let monotonic = 0
  let metrics = { ...lab }
  const events: DisplayGuardEvent[] = []
  const controller = new DisplayGuardController(
    enabled,
    () => metrics,
    () => now,
    () => monotonic,
  )
  const configure = (owner: string | null = 'participant', required = true, focus = true) =>
    controller.configure(owner, required, focus, (event) => events.push(event))
  const advance = (ms: number) => {
    now += ms
    monotonic += ms
  }
  const change = (next: Partial<DisplayMetrics>) => {
    metrics = { ...metrics, ...next }
  }
  const verify = () => {
    advance(500)
    expect(controller.resume()).toBe(true)
  }
  return { controller, events, configure, advance, change, verify, time: () => now }
}

describe('fixed lab geometry', () => {
  test('accepts fullscreen at native resolution, including F11 without the fullscreen API', () => {
    expect(displayProblems(lab, true)).toEqual([])
    expect(displayProblems({ ...lab, extended: undefined }, true)).toEqual([])
  })

  test.each<[Partial<DisplayMetrics>, string]>([
    [{ screenWidth: 2560 }, 'screen_resolution'],
    [{ innerHeight: 980 }, 'window_size'],
    [{ outerWidth: 1500 }, 'window_size'],
    [{ x: 1920 }, 'window_position'],
    [{ y: 10 }, 'window_position'],
    [{ dpr: 1.25 }, 'display_scale'],
    [{ viewport: { scale: 1.1, x: 0, y: 0 } }, 'viewport_zoom'],
    [{ viewport: { scale: 1, x: 10, y: 0 } }, 'viewport_zoom'],
    [{ extended: true }, 'multiple_displays'],
    [{ focused: false }, 'window_focus'],
    [{ visible: false }, 'window_focus'],
    [{ dpr: NaN }, 'display_scale'],
  ])('rejects %j', (change, reason) => {
    expect(displayProblems({ ...lab, ...change }, true)).toContain(reason)
  })

  test('intro display selection may lose focus; measured pages may not', () => {
    expect(displayProblems({ ...lab, focused: false }, false)).toEqual([])
    expect(displayProblems({ ...lab, focused: false }, true)).toEqual(['window_focus'])
  })
})

test('stable geometry requires explicit verification and does not admit initial capture', () => {
  const s = setup()
  s.configure()
  expect(s.controller.check()).toBe(false)
  expect(s.controller.resume()).toBe(false)
  s.advance(500)
  expect(s.controller.check()).toBe(false)
  expect(s.controller.getSnapshot().phase).toBe('ready')
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.controller.resume()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(true)
  expect(s.events.map((e) => e.event_type)).toEqual([
    'display_guard_interrupted',
    'display_guard_resumed',
  ])
})

test('sample receipt detects changes before browser events, backdating the exclusion conservatively', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(10)
  expect(s.controller.allowsSample(s.time())).toBe(true)
  const preceding = s.time()
  s.advance(8)
  s.change({ innerWidth: 1500 })
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.events[s.events.length - 1]).toMatchObject({
    event_type: 'display_guard_interrupted',
    client_ts: preceding,
    payload: { detected_at: s.time(), reasons: ['window_size'] },
  })
  const count = s.events.length
  s.controller.check()
  expect(s.events).toHaveLength(count)
  s.change({ innerWidth: 1920 })
  s.controller.check()
  s.advance(500)
  s.controller.check()
  expect(s.controller.getSnapshot().phase).toBe('ready')
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.controller.resume()).toBe(true)
  expect(s.controller.allowsSample(preceding)).toBe(false)
  expect(s.controller.allowsSample(s.time())).toBe(true)
})

test('geometry must be continuously stable before resume', () => {
  const s = setup()
  s.configure()
  s.advance(400)
  s.change({ dpr: 1.1 })
  s.controller.check()
  s.change({ dpr: 1 })
  s.controller.check()
  s.advance(100)
  expect(s.controller.resume()).toBe(false)
  s.advance(400)
  expect(s.controller.resume()).toBe(true)
})

test('a delayed browser event excludes samples already received after the actual display change', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(8)
  s.controller.allowsSample(s.time())
  const lastBeforeChange = s.time()
  s.advance(4)
  const changedAt = s.time()
  // Dimensions are restored and sample callbacks arrive before the queued event.
  s.advance(50)
  expect(s.controller.allowsSample(s.time())).toBe(true)
  s.controller.interrupt('window_size', changedAt)
  expect(s.events[s.events.length - 1].client_ts).toBe(lastBeforeChange)
  expect(s.controller.getSnapshot().phase).toBe('blocked')
})

test('an event older than the bounded observation history conservatively excludes from verification', () => {
  const s = setup()
  s.configure()
  s.verify()
  const verifiedAt = s.time()
  for (let index = 0; index < 600; index++) {
    s.advance(8)
    s.controller.check()
  }
  s.controller.interrupt('window_size', s.time())
  s.controller.interrupt('window_size', verifiedAt + 1)
  expect(s.events[s.events.length - 1].client_ts).toBe(verifiedAt)
})

test('an older queued event extends an already logged interruption without duplicating later starts', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(8)
  s.controller.check()
  const earlierObservation = s.time()
  s.advance(54)
  s.controller.check()
  const latestObservation = s.time()
  s.advance(8)
  s.controller.interrupt('window_size', latestObservation + 2)
  expect(s.events[s.events.length - 1].client_ts).toBe(latestObservation)
  s.controller.interrupt('window_focus', earlierObservation + 4)
  expect(s.events[s.events.length - 1].client_ts).toBe(earlierObservation)
  const count = s.events.length
  s.controller.interrupt('window_size', latestObservation + 3)
  expect(s.events).toHaveLength(count)
  expect(s.controller.getSnapshot().phase).toBe('blocked')
})

test('browser fractional timestamps become conservative integer API timestamps', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.controller.interrupt('window_size', s.time() - 0.25)
  expect(s.events[s.events.length - 1].client_ts).toBe(s.time() - 1)
  expect(s.events.every((event) => Number.isInteger(event.client_ts))).toBe(true)
})

test('SoSci is exempt, ordinary page changes keep verification, returning requires fresh confirmation', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.configure('participant', true, false)
  expect(s.controller.getSnapshot().phase).toBe('verified')
  s.configure('participant', false, false)
  s.change({ innerWidth: 1000, focused: false })
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  s.configure('participant', true, true)
  expect(s.controller.check()).toBe(false)
  s.change(lab)
  s.controller.check()
  s.verify()
})

test('an owner switch never exposes the previous participant verification to subscribers', () => {
  const s = setup()
  s.configure()
  s.verify()
  const snapshots: ReturnType<typeof s.controller.getSnapshot>[] = []
  const unsubscribe = s.controller.subscribe(() => snapshots.push(s.controller.getSnapshot()))
  s.configure('new-participant')
  expect(snapshots.length).toBeGreaterThan(0)
  expect(snapshots.every((snapshot) => snapshot.phase !== 'verified')).toBe(true)
  s.controller.release('participant')
  expect(s.controller.getSnapshot().owner).toBe('new-participant')
  s.controller.release('new-participant')
  expect(s.controller.allowsSample(s.time())).toBe(false)
  unsubscribe()
})

test('backwards clock change blocks capture until the clock is coherent and reverified', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(-1000)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.controller.getSnapshot().reasons).toContain('clock_changed')
  s.advance(1001)
  s.controller.check()
  s.verify()
})

test('disabled guard preserves legacy behavior and emits no events', () => {
  const s = setup(false)
  s.configure()
  s.change({ innerWidth: 300, dpr: 2 })
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(1)).toBe(true)
  expect(s.controller.getSnapshot().phase).toBe('disabled')
  expect(s.events).toEqual([])
})
