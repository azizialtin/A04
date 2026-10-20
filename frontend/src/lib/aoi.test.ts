import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { capturePageGeometry, observePageGeometry, visibleBox } from './aoi'

function box(el: Element, x: number, y: number, width: number, height: number) {
  vi.spyOn(el, 'getBoundingClientRect').mockReturnValue(new DOMRect(x, y, width, height))
}

function area(id: string, parent: HTMLElement = document.body) {
  const el = document.createElement('div')
  el.dataset.aoi = id
  parent.append(el)
  box(el, 10, 20, 200, 100)
  return el
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 800)
  vi.stubGlobal('innerHeight', 600)
  vi.spyOn(document, 'hasFocus').mockReturnValue(true)
})

afterEach(() => {
  document.body.replaceChildren()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

test('an AOI is the visible intersection of the viewport and nested scroll areas', () => {
  const horizontal = document.createElement('div')
  horizontal.style.overflowX = 'auto'
  document.body.append(horizontal)
  box(horizontal, 100, 0, 400, 700)
  Object.defineProperties(horizontal, {
    clientLeft: { value: 2 },
    clientWidth: { value: 380 },
  })
  const vertical = document.createElement('div')
  vertical.style.overflowY = 'hidden'
  horizontal.append(vertical)
  box(vertical, 0, 80, 900, 300)
  Object.defineProperties(vertical, {
    clientTop: { value: 3 },
    clientHeight: { value: 250 },
  })
  const question = area('question:1', vertical)
  box(question, -20, 50, 1000, 700)

  expect(visibleBox(question)).toEqual({ x: 102, y: 83, w: 380, h: 250 })
  box(question, 700, 400, 100, 100)
  expect(visibleBox(question)).toBeNull()
})

test('offscreen and hidden questions cannot receive gaze attribution', () => {
  const visible = area('question:visible')
  box(visible, -50, 550, 150, 100)
  const offscreen = area('question:offscreen')
  box(offscreen, 810, 20, 50, 50)
  const hidden = area('question:hidden')
  hidden.hidden = true
  const collapsed = area('question:collapsed')
  collapsed.style.visibility = 'hidden'
  const parent = document.createElement('section')
  parent.style.opacity = '0'
  document.body.append(parent)
  area('question:transparent-parent', parent)

  expect(capturePageGeometry().aois).toEqual([
    { id: 'question:visible', x: 0, y: 550, w: 100, h: 50, priority: 0 },
  ])
})

test('horizontally scrolled matrix answers exclude the area under their sticky prompt', () => {
  const scroll = document.createElement('div')
  scroll.style.overflowX = 'auto'
  document.body.append(scroll)
  box(scroll, 50, 80, 300, 120)
  Object.defineProperties(scroll, { clientLeft: { value: 0 }, clientWidth: { value: 300 } })
  const table = document.createElement('table')
  scroll.append(table)
  const row = table.insertRow()
  const prompt = document.createElement('th')
  prompt.dataset.aoi = 'question.matrix.prompt'
  prompt.dataset.aoiPriority = '2'
  prompt.dataset.aoiRowPrompt = ''
  row.append(prompt)
  box(prompt, 50, 100, 180, 50)
  for (const [left, width] of [
    [40, 70],
    [210, 80],
    [290, 80],
  ]) {
    const answer = row.insertCell()
    answer.dataset.aoi = 'question.matrix.answer'
    answer.dataset.aoiPriority = '1'
    answer.dataset.aoiClip = 'after-row-prompt'
    box(answer, left, 100, width, 50)
  }

  expect(capturePageGeometry().aois).toEqual([
    { id: 'question.matrix.prompt', x: 50, y: 100, w: 180, h: 50, priority: 2 },
    { id: 'question.matrix.answer', x: 230, y: 100, w: 60, h: 50, priority: 1 },
    { id: 'question.matrix.answer', x: 290, y: 100, w: 60, h: 50, priority: 1 },
  ])
})

test('the top visible modal replaces background AOIs while retaining precise child regions', () => {
  area('question:background')
  const first = area('dialog:first')
  first.setAttribute('aria-modal', 'true')
  const top = area('dialog:student-task')
  top.setAttribute('aria-modal', 'true')
  top.dataset.aoiModal = 'student_task'
  const code = area('student-task:code', top)
  code.dataset.aoiPriority = '20'
  code.textContent = 'secret answer content must not enter geometry'
  const closed = area('dialog:closed')
  closed.setAttribute('aria-modal', 'true')
  closed.style.display = 'none'

  const captured = capturePageGeometry()
  expect(captured.active_modal).toBe('student_task')
  expect(captured.aois?.map(({ id, priority }) => ({ id, priority }))).toEqual([
    { id: 'dialog:student-task', priority: 0 },
    { id: 'student-task:code', priority: 20 },
  ])
  expect(JSON.stringify(captured)).not.toContain('secret answer')
})

test('focus, screen position and clip dimensions remain with a layout snapshot', () => {
  vi.spyOn(document, 'hasFocus').mockReturnValue(false)
  vi.stubGlobal('screenX', 240)
  vi.stubGlobal('screenY', 40)
  vi.stubGlobal('devicePixelRatio', 2)
  const video = document.createElement('video')
  video.dataset.gazeVideo = ''
  document.body.append(video)
  box(video, 50, 100, 640, 360)
  Object.defineProperties(video, {
    videoWidth: { value: 1920 },
    videoHeight: { value: 1080 },
  })

  expect(capturePageGeometry()).toMatchObject({
    visible: false,
    active_modal: null,
    dpr: 2,
    window: { x: 240, y: 40, inner_w: 800, inner_h: 600 },
    video: { x: 50, y: 100, w: 640, h: 360 },
    frame: { w: 1920, h: 1080 },
  })
})

test('notifications follow their painted stack and only foreground notices survive a modal', () => {
  area('question.answer')
  const modal = area('student_task_dialog')
  modal.setAttribute('aria-modal', 'true')
  Object.assign(modal.style, { position: 'fixed', zIndex: '200' })
  const unsent = area('unsent_notice')
  unsent.dataset.aoiOverlay = 'true'
  unsent.dataset.aoiPriority = '100'
  Object.assign(unsent.style, { position: 'fixed', zIndex: '200', pointerEvents: 'none' })
  const stack = document.createElement('div')
  Object.assign(stack.style, { position: 'fixed', zIndex: '100' })
  document.body.append(stack)
  const toast = area('notification', stack)
  toast.dataset.aoiOverlay = 'true'
  toast.dataset.aoiPriority = '100'

  expect(capturePageGeometry().aois?.map(({ id }) => id)).toEqual([
    'student_task_dialog',
    'unsent_notice',
  ])
  // The supervisor dialog is later at the same z-index and covers both notices.
  document.body.append(modal)
  expect(capturePageGeometry().aois?.map(({ id }) => id)).toEqual(['student_task_dialog'])
  modal.remove()
  // The later toast in DOM order still paints below the earlier unsent banner.
  expect(capturePageGeometry().aois?.map(({ id }) => id)).toEqual([
    'question.answer',
    'notification',
    'unsent_notice',
  ])
})

test('an overlay within a modal is captured once and hidden notices are excluded', () => {
  const modal = area('dialog')
  modal.setAttribute('aria-modal', 'true')
  const toast = area('notification', modal)
  toast.dataset.aoiOverlay = 'true'
  const hidden = area('unsent_notice')
  hidden.dataset.aoiOverlay = 'true'
  hidden.style.display = 'none'
  expect(capturePageGeometry().aois?.map(({ id }) => id)).toEqual(['dialog', 'notification'])
})

test('snapshots preserve visual viewport scaling and known extended-display state', () => {
  vi.stubGlobal('visualViewport', {
    scale: 1.5,
    offsetLeft: 12,
    offsetTop: 24,
    width: 500,
    height: 400,
  })
  vi.stubGlobal('screen', { width: 1920, height: 1080, isExtended: true })
  expect(capturePageGeometry()).toMatchObject({
    screen: { w: 1920, h: 1080, is_extended: true },
    visual_viewport: { scale: 1.5, x: 12, y: 24, w: 500, h: 400 },
  })
})

test('layout observations coalesce bursts and teardown stops pending and future callbacks', async () => {
  vi.useFakeTimers()
  const target = area('question:1')
  const changed = vi.fn(() => capturePageGeometry())
  const stop = observePageGeometry(changed)
  await vi.advanceTimersByTimeAsync(20)
  expect(changed).toHaveBeenCalledTimes(1)

  for (let i = 0; i < 20; i++) {
    target.style.setProperty('--played', `${i}%`)
    target.dispatchEvent(new Event('scroll'))
  }
  await Promise.resolve()
  await vi.advanceTimersByTimeAsync(20)
  expect(changed).toHaveBeenCalledTimes(2)
  // Measuring does not itself mutate the observed document or keep scheduling frames.
  await vi.advanceTimersByTimeAsync(100)
  expect(changed).toHaveBeenCalledTimes(2)

  target.dispatchEvent(new Event('input', { bubbles: true }))
  stop()
  target.style.width = '300px'
  window.dispatchEvent(new Event('resize'))
  await vi.advanceTimersByTimeAsync(3000)
  expect(changed).toHaveBeenCalledTimes(2)
})
