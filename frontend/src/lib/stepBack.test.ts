import { isStepBackChord } from './stepBack'

const key = (over: Partial<Parameters<typeof isStepBackChord>[0]>) => ({
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  code: 'KeyB',
  repeat: false,
  ...over,
})

test('only the full chord counts, with Ctrl or Cmd', () => {
  expect(isStepBackChord(key({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(true)
  expect(isStepBackChord(key({ metaKey: true, altKey: true, shiftKey: true }))).toBe(true)
  expect(isStepBackChord(key({ ctrlKey: true, shiftKey: true }))).toBe(false)
  expect(isStepBackChord(key({ ctrlKey: true, altKey: true }))).toBe(false)
  expect(isStepBackChord(key({ altKey: true, shiftKey: true }))).toBe(false)
  expect(isStepBackChord(key({ ctrlKey: true, altKey: true, shiftKey: true, code: 'KeyA' }))).toBe(
    false,
  )
})

test('a held key does not fire again and again', () => {
  expect(isStepBackChord(key({ ctrlKey: true, altKey: true, shiftKey: true, repeat: true }))).toBe(
    false,
  )
})
