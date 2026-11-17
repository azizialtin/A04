import { describe, expect, test } from 'vitest'

import {
  DisplayGuardController,
  displayProblems,
  isDisplayGuardBlocking,
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

function observing(native?: () => { capable: boolean; proof: null }) {
  let now = 100_000
  let monotonic = 0
  let metrics = { ...lab }
  const events: DisplayGuardEvent[] = []
  const controller = new DisplayGuardController(
    true,
    () => metrics,
    () => now,
    () => monotonic,
    native ?? (() => ({ capable: false, proof: null })),
    false,
  )
  const configure = (owner: string | null = 'participant', scope: DisplayGuardScope = 'required') =>
    controller.configure(owner, scope, (event) => events.push(event))
  const advance = (ms: number) => {
    now += ms
    monotonic += ms
    return controller.check()
  }
  const change = (next: Partial<DisplayMetrics>) => {
    metrics = { ...metrics, ...next }
  }
  const kinds = () => events.map((event) => event.event_type.replace('display_guard_', ''))
  return { controller, events, configure, advance, change, kinds, time: () => now }
}

describe('observing guard (no blocking)', () => {
  test('never withholds the task, not even before the display has been checked', () => {
    const { controller, configure, change } = observing()
    expect(controller.check()).toBe(true)
    change({ dpr: 1.25, screenWidth: 1536, screenHeight: 864 })
    configure()
    expect(controller.check()).toBe(true)
    expect(isDisplayGuardBlocking(controller.getSnapshot())).toBe(false)
    expect(controller.getSnapshot()).toMatchObject({ blocking: false, phase: 'blocked' })
  })

  test('a correct display verifies itself after the stability window, without a click', () => {
    const { controller, configure, advance, kinds, events, time } = observing()
    configure()
    expect(controller.getSnapshot()).toMatchObject({
      phase: 'blocked',
      reasons: ['checking_display'],
    })
    expect(controller.allowsSample(time())).toBe(false)
    advance(499)
    expect(controller.getSnapshot().phase).toBe('blocked')
    advance(1)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'verified', reasons: [] })
    expect(kinds()).toEqual(['interrupted', 'resumed'])
    // The backend cannot close an interval whose two ends share a timestamp.
    expect(events[1].client_ts).toBeGreaterThan(events[0].client_ts)
    expect(controller.allowsSample(time())).toBe(true)
    expect(controller.allowsSample(time() - 1)).toBe(false)
  })

  test('a wrong display keeps gaze out, keeps the task open and does not flood events', () => {
    const { controller, configure, advance, change, kinds, time } = observing()
    change({ dpr: 1.25, screenWidth: 1536, screenHeight: 864, innerWidth: 1536, innerHeight: 864 })
    configure()
    for (let i = 0; i < 400; i++) expect(advance(125)).toBe(true)
    expect(controller.getSnapshot().phase).toBe('blocked')
    expect(controller.getSnapshot().reasons).toEqual(
      expect.arrayContaining(['screen_resolution', 'window_size', 'display_scale']),
    )
    expect(controller.allowsSample(time())).toBe(false)
    expect(kinds()).toEqual(['interrupted'])
  })

  test('a disturbance revokes verification and recovery needs nobody', () => {
    const { controller, configure, advance, change, kinds, events, time } = observing()
    configure()
    advance(500)
    advance(1000)
    change({ innerHeight: 950 })
    expect(advance(125)).toBe(true)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'blocked', reasons: ['window_size'] })
    expect(controller.allowsSample(time())).toBe(false)
    change({ innerHeight: 1080 })
    advance(125)
    expect(controller.getSnapshot().phase).toBe('blocked')
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
    expect(kinds()).toEqual(['interrupted', 'resumed', 'interrupted', 'resumed'])
    // The gap starts at the last observation that was still correct.
    expect(events[2].client_ts).toBe(time() - 750)
    expect(events[3].client_ts).toBe(time())
    expect(controller.allowsSample(time())).toBe(true)
  })

  test('a display that keeps changing is never verified in between', () => {
    const { controller, configure, advance, change } = observing()
    configure()
    for (let i = 0; i < 20; i++) {
      change({ innerHeight: i % 2 ? 1080 : 950 })
      advance(400)
      expect(controller.getSnapshot().phase).toBe('blocked')
    }
  })

  test('losing and regaining focus recovers by itself on a measured page', () => {
    const { controller, configure, advance, change, kinds } = observing()
    configure()
    advance(500)
    change({ focused: false })
    controller.interrupt('window_focus')
    expect(controller.getSnapshot()).toMatchObject({ phase: 'blocked', reasons: ['window_focus'] })
    change({ focused: true })
    advance(125)
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
    expect(kinds()).toEqual(['interrupted', 'resumed', 'interrupted', 'resumed'])
  })

  test('monitored pages report a correct display as ready with nothing pending', () => {
    const { controller, configure, advance, kinds } = observing()
    configure('participant', 'monitor')
    advance(500)
    expect(controller.getSnapshot()).toMatchObject({ phase: 'ready', reasons: [] })
    expect(kinds()).toEqual([])
    configure('participant', 'required')
    expect(controller.getSnapshot().phase).toBe('blocked')
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
    // Consecutive measured pages and the instructions between them keep it.
    configure('participant', 'monitor')
    configure('participant', 'required')
    expect(controller.getSnapshot().phase).toBe('verified')
    expect(kinds()).toEqual(['interrupted', 'resumed'])
  })

  test('returning from a survey or replay verifies again without a confirmation', () => {
    const { controller, configure, advance, kinds } = observing()
    configure()
    advance(500)
    configure('participant', 'suspended')
    expect(controller.check()).toBe(true)
    advance(60_000)
    configure('participant', 'required')
    expect(controller.getSnapshot().phase).toBe('blocked')
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
    expect(kinds()).toEqual(['interrupted', 'resumed', 'interrupted', 'resumed'])
  })

  test('a new participant never inherits the previous verification', () => {
    const { controller, configure, advance, time } = observing()
    configure('first')
    advance(500)
    expect(controller.allowsSample(time())).toBe(true)
    configure('second')
    expect(controller.getSnapshot()).toMatchObject({ owner: 'second', phase: 'blocked' })
    expect(controller.allowsSample(time())).toBe(false)
  })

  test('a clock stepping backwards is not verified until time passes the old mark', () => {
    let now = 100_000
    let monotonic = 0
    const controller = new DisplayGuardController(
      true,
      () => ({ ...lab }),
      () => now,
      () => monotonic,
      () => ({ capable: false, proof: null }),
      false,
    )
    controller.configure('participant', 'required', () => {})
    now += 500
    monotonic += 500
    controller.check()
    expect(controller.getSnapshot().phase).toBe('verified')
    now -= 10_000
    monotonic += 125
    controller.check()
    expect(controller.getSnapshot()).toMatchObject({ phase: 'blocked', reasons: ['clock_changed'] })
  })

  test('the fullscreen profile waits for a bridge that is still answering, then yields to it', () => {
    let bridge: { capable: boolean; proof: { id: string } | null; pending?: boolean } = {
      capable: false,
      proof: null,
      pending: true,
    }
    const { controller, configure, advance, events } = observing(() => bridge as never)
    configure()
    advance(3000)
    // Correct by the fullscreen rules, but verifying now would be undone at once.
    expect(controller.getSnapshot()).toMatchObject({
      profile: 'lab_1080p',
      phase: 'blocked',
      reasons: ['checking_display'],
    })
    bridge = { capable: true, proof: { id: 'one' } }
    advance(125)
    advance(500)
    expect(controller.getSnapshot()).toMatchObject({
      profile: 'native_viewport_v1',
      phase: 'verified',
    })
    // No stretch was ever verified under the profile that was about to be replaced.
    expect(
      events
        .filter((event) => event.event_type === 'display_guard_resumed')
        .map((event) => event.payload.profile),
    ).toEqual(['native_viewport_v1'])
  })

  test('a bridge that turns out to be unreachable or older releases the fullscreen profile', () => {
    let bridge = { capable: false, proof: null, pending: true }
    const { controller, configure, advance } = observing(() => bridge as never)
    configure()
    advance(1000)
    expect(controller.getSnapshot().phase).toBe('blocked')
    bridge = { capable: false, proof: null, pending: false }
    advance(125)
    expect(controller.getSnapshot()).toMatchObject({ profile: 'lab_1080p', phase: 'verified' })
    // A later reconnect attempt does not take a standing verification away.
    bridge = { capable: false, proof: null, pending: true }
    advance(125)
    expect(controller.getSnapshot().phase).toBe('verified')
  })

  test('a bridge that announces itself after the fullscreen profile verified takes over cleanly', () => {
    let bridge: { capable: boolean; proof: { id: string } | null } = { capable: false, proof: null }
    const { controller, configure, advance, events, time } = observing(() => bridge as never)
    configure()
    advance(500)
    expect(controller.getSnapshot()).toMatchObject({ profile: 'lab_1080p', phase: 'verified' })
    bridge = { capable: true, proof: null }
    advance(125)
    expect(controller.getSnapshot()).toMatchObject({
      profile: 'native_viewport_v1',
      phase: 'blocked',
    })
    expect(controller.allowsSample(time())).toBe(false)
    bridge = { capable: true, proof: { id: 'one' } }
    advance(125)
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
    // Each profile's last word is a resume later than its interruption.
    const last = (profile: string, kind: string) =>
      events
        .filter((e) => e.payload.profile === profile && e.event_type.endsWith(kind))
        .slice(-1)[0]
    expect(last('native_viewport_v1', 'resumed').client_ts).toBeGreaterThan(
      last('native_viewport_v1', 'interrupted').client_ts,
    )
  })

  test('the waiver of the blocking dialog does not exist here', () => {
    const { controller, configure, change } = observing()
    change({ dpr: 1.25 })
    configure()
    expect(controller.continueUnverified()).toBe(false)
    expect(controller.getSnapshot().unverifiedContinuation).toBe(false)
    expect(controller.resume()).toBe(false)
  })

  test('a bridge that measures the page needs a current measurement, not a confirmation', () => {
    let proof: { id: string } | null = null
    const { controller, configure, advance } = observing(() => ({ capable: true, proof }) as never)
    configure()
    advance(2000)
    expect(controller.getSnapshot()).toMatchObject({
      profile: 'native_viewport_v1',
      phase: 'blocked',
      reasons: ['native_measurement'],
    })
    proof = { id: 'one' }
    advance(125)
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
    proof = null
    advance(125)
    expect(controller.getSnapshot().phase).toBe('blocked')
    proof = { id: 'two' }
    advance(125)
    advance(500)
    expect(controller.getSnapshot().phase).toBe('verified')
  })
})
