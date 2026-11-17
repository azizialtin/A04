import { describe, expect, test } from 'vitest'

import {
  DisplayGuardController,
  displayProblems,
  type DisplayGuardEvent,
  type DisplayGuardScope,
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
  const configure = (owner: string | null = 'participant', scope: DisplayGuardScope = 'required') =>
    controller.configure(owner, scope, (event) => events.push(event))
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
  s.configure('participant', 'monitor')
  expect(s.controller.getSnapshot().phase).toBe('verified')
  s.configure('participant', 'suspended')
  s.change({ innerWidth: 1000, focused: false })
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  s.configure('participant', 'required')
  expect(s.controller.check()).toBe(false)
  s.change(lab)
  s.controller.check()
  s.verify()
})

test('unverified welcome and instruction pages remain actionable with invalid settings', () => {
  const s = setup()
  s.change({ innerWidth: 1200, focused: false })
  s.configure('participant', 'monitor')
  expect(s.controller.check()).toBe(true)
  expect(s.controller.getSnapshot().required).toBe(false)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.controller.resume()).toBe(false)
  expect(s.events).toEqual([])
  s.configure()
  expect(s.controller.check()).toBe(false)
  expect(s.events).toHaveLength(1)
  s.change(lab)
  s.controller.check()
  s.verify()
})

test('ordinary instruction pages retain valid verification without admitting their own gaze', () => {
  const s = setup()
  s.configure()
  s.verify()
  const generation = s.controller.getSnapshot().generation
  s.configure('participant', 'monitor')
  s.advance(2000)
  expect(s.controller.check()).toBe(true)
  expect(s.controller.getSnapshot().phase).toBe('verified')
  expect(s.controller.allowsSample(s.time())).toBe(false)
  s.configure()
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(true)
  expect(s.controller.getSnapshot().generation).toBe(generation)
  expect(s.events.map((event) => event.event_type)).toEqual([
    'display_guard_interrupted',
    'display_guard_resumed',
  ])
})

test('a silent geometry change permits instruction navigation but revokes the next measured page', () => {
  const s = setup()
  s.configure()
  s.verify()
  const lastVerifiedObservation = s.time()
  s.configure('participant', 'monitor')
  s.advance(100)
  s.change({ innerWidth: 1600 })
  expect(s.controller.check()).toBe(true)
  expect(s.controller.getSnapshot()).toMatchObject({ phase: 'blocked', required: false })
  expect(s.events[s.events.length - 1].client_ts).toBe(lastVerifiedObservation)
  s.change(lab)
  s.controller.check()
  s.advance(500)
  expect(s.controller.check()).toBe(true)
  expect(s.controller.resume()).toBe(false)
  s.configure()
  expect(s.controller.check()).toBe(false)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  s.verify()
  expect(s.controller.allowsSample(s.time())).toBe(true)
  expect(s.events.filter((event) => event.event_type === 'display_guard_resumed')).toHaveLength(2)
})

test('delayed measured-page events still backdate exclusions after entering a quiet instruction page', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(8)
  s.controller.check()
  const previousObservation = s.time()
  s.advance(4)
  const changedAt = s.time()
  s.advance(20)
  s.configure('participant', 'monitor')
  s.advance(50)
  s.controller.check()
  s.controller.interrupt('window_focus', changedAt)
  expect(s.controller.check()).toBe(true)
  expect(s.events[s.events.length - 1].client_ts).toBe(previousObservation)
  s.configure()
  expect(s.controller.check()).toBe(false)
})

test('returning from an external page through an ordinary intro never restores verification automatically', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.configure('participant', 'suspended')
  s.configure('participant', 'monitor')
  s.advance(500)
  expect(s.controller.check()).toBe(true)
  expect(s.controller.getSnapshot().phase).toBe('ready')
  s.configure()
  expect(s.controller.check()).toBe(false)
  s.verify()
})

test('SoSci remains exempt while delayed events from the previous measured page correct its exclusion boundary', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(8)
  s.controller.check()
  const previousObservation = s.time()
  s.advance(4)
  const changedAt = s.time()
  s.advance(20)
  s.configure('participant', 'suspended')
  const suspendedAt = s.time()
  s.advance(50)
  s.controller.interrupt('window_focus', changedAt)
  expect(s.events[s.events.length - 1].client_ts).toBe(previousObservation)
  expect(s.controller.getSnapshot().phase).toBe('suspended')
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  const count = s.events.length
  s.controller.interrupt('window_size', suspendedAt + 1)
  s.controller.interrupt('window_focus', 0) // An unknown event clock proves no preceding change.
  expect(s.events).toHaveLength(count)
  s.configure('participant', 'monitor')
  expect(s.controller.check()).toBe(true)
  s.configure()
  expect(s.controller.check()).toBe(false)
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

test.each<Partial<DisplayMetrics>>([
  { innerWidth: 1366, innerHeight: 768 },
  { x: -8, y: -8, outerWidth: 1936, outerHeight: 1096 },
  { dpr: 1.25, screenWidth: 1536, screenHeight: 864 },
])('researcher can continue with %j without certifying gaze', (metrics) => {
  const s = setup()
  s.change(metrics)
  s.configure()
  expect(s.controller.check()).toBe(false)
  expect(s.controller.resume()).toBe(false)
  expect(s.controller.continueUnverified()).toBe(true)
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.events.map((event) => event.event_type)).toEqual([
    'display_guard_interrupted',
    'display_guard_continued_unverified',
  ])
  // Idempotent permission survives subsequent geometry and focus events.
  s.controller.continueUnverified()
  s.controller.interrupt('window_focus')
  s.advance(1000)
  s.change({ ...lab, innerWidth: 1200 })
  expect(s.controller.check()).toBe(true)
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(
    s.events.filter((event) => event.event_type === 'display_guard_continued_unverified'),
  ).toHaveLength(1)
})

test('unverified continuation survives SoSci and page changes but never transfers to another participant', () => {
  const s = setup()
  s.change({ innerHeight: 900 })
  s.configure()
  s.controller.continueUnverified()
  for (const scope of ['monitor', 'suspended', 'required'] as const) {
    s.configure('participant', scope)
    expect(s.controller.check()).toBe(true)
    expect(s.controller.getSnapshot().unverifiedContinuation).toBe(true)
  }
  s.configure('other-participant')
  expect(s.controller.check()).toBe(false)
  expect(s.controller.getSnapshot().unverifiedContinuation).toBe(false)
  s.controller.continueUnverified()
  s.controller.release('other-participant')
  s.configure('other-participant')
  expect(s.controller.check()).toBe(false)
})

test('restoring display after unverified continuation still requires a real verification boundary', () => {
  const s = setup()
  s.configure()
  s.verify()
  s.advance(100)
  s.change({ innerHeight: 900 })
  expect(s.controller.check()).toBe(false)
  s.controller.continueUnverified()
  const unverifiedAt = s.time()
  s.change(lab)
  s.controller.check()
  s.advance(500)
  expect(s.controller.check()).toBe(true)
  expect(s.controller.getSnapshot().phase).toBe('ready')
  expect(s.controller.allowsSample(s.time())).toBe(false)
  expect(s.events.filter((event) => event.event_type === 'display_guard_resumed')).toHaveLength(1)
  expect(s.controller.resume()).toBe(true)
  expect(s.controller.getSnapshot().unverifiedContinuation).toBe(false)
  expect(s.controller.allowsSample(unverifiedAt)).toBe(false)
  expect(s.controller.allowsSample(s.time())).toBe(true)
  expect(s.events.filter((event) => event.event_type === 'display_guard_resumed')).toHaveLength(2)
})

test('native mapping verifies a windowed scaled viewport and automatically remeasures after resize', () => {
  let now = 100_000
  let metrics = {
    ...lab,
    innerWidth: 1200,
    innerHeight: 720,
    outerWidth: 1536,
    outerHeight: 980,
    dpr: 1.25,
    x: -8,
  }
  const native = {
    capable: true,
    proof: {
      id: 'native-1',
      tab_id: 'a'.repeat(32),
      display: { x: 0, y: 0, w: 1920, h: 1080 },
      content: { x: 100, y: 100, w: 1500, h: 900 },
      css: { w: 1200, h: 720 },
      dpr: 1.25,
    } as import('./nativeViewport').NativeViewport | null,
  }
  const events: DisplayGuardEvent[] = []
  const controller = new DisplayGuardController(
    true,
    () => metrics,
    () => now,
    () => now,
    () => native,
  )
  controller.configure('participant', 'required', (event) => events.push(event))
  now += 500
  expect(controller.check()).toBe(false)
  expect(controller.getSnapshot()).toMatchObject({ profile: 'native_viewport_v1', phase: 'ready' })
  expect(controller.resume()).toBe(true)
  expect(controller.allowsSample(now)).toBe(true)
  native.proof = null
  now += 20
  expect(controller.check()).toBe(false)
  expect(controller.allowsSample(now)).toBe(false)
  metrics = { ...metrics, innerWidth: 1000 }
  native.proof = {
    id: 'native-2',
    tab_id: 'a'.repeat(32),
    display: { x: 0, y: 0, w: 1920, h: 1080 },
    content: { x: 100, y: 100, w: 1250, h: 900 },
    css: { w: 1000, h: 720 },
    dpr: 1.25,
  }
  controller.check()
  now += 500
  expect(controller.check()).toBe(true)
  expect(controller.getSnapshot().phase).toBe('verified')
  expect(events.filter((event) => event.event_type === 'display_guard_resumed')).toHaveLength(2)
  expect(
    events
      .filter((event) => event.event_type === 'display_guard_resumed')
      .every((event) => event.payload.profile === 'native_viewport_v1'),
  ).toBe(true)
})

test('native proof changes revoke verification even when browser metrics appear unchanged', () => {
  let now = 100_000
  const native = {
    capable: true,
    proof: {
      id: 'native-1',
      tab_id: 'a'.repeat(32),
      display: { x: 0, y: 0, w: 1920, h: 1080 },
      content: { x: 0, y: 0, w: 1920, h: 1080 },
      css: { w: 1920, h: 1080 },
      dpr: 1,
    },
  }
  const controller = new DisplayGuardController(
    true,
    () => lab,
    () => now,
    () => now,
    () => native,
  )
  controller.configure('participant', 'required')
  now += 500
  controller.resume()
  native.proof = { ...native.proof, id: 'native-2' }
  expect(controller.check()).toBe(false)
  expect(controller.getSnapshot().phase).toBe('blocked')
  expect(controller.allowsSample(now)).toBe(false)
  expect(controller.continueUnverified()).toBe(true)
  now += 500
  expect(controller.check()).toBe(true)
  expect(controller.getSnapshot().phase).toBe('ready')
  expect(controller.allowsSample(now)).toBe(false)
})
