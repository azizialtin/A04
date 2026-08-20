import { describe, expect, test } from 'vitest'

import { generateIds, randomCode } from './adminIds'

describe('random ids (the default)', () => {
  test('are not guessable from one another', () => {
    const ids = generateIds('TN-', 3)
    expect(ids).toHaveLength(3)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(id).toMatch(/^TN-[ACDEFGHJKMNPQRTUVWXY34679]{5}$/)
  })

  test('give the researcher exactly the number asked for', () => {
    expect(generateIds('X', 40)).toHaveLength(40)
    expect(new Set(generateIds('X', 40)).size).toBe(40)
  })

  test('leave out characters that are misread when typed in', () => {
    const sample = Array.from({ length: 200 }, () => randomCode(8)).join('')
    expect(sample).not.toMatch(/[01OIL5S2Z8B]/)
  })
})

describe('sequential ids', () => {
  test('are zero-padded from the prefix and count', () => {
    expect(generateIds('TN-', 3, { sequential: true })).toEqual(['TN-001', 'TN-002', 'TN-003'])
  })

  test('respect a custom pad width', () => {
    expect(generateIds('P', 1, { sequential: true, pad: 2 })).toEqual(['P01'])
  })
})

describe('bounds', () => {
  test('handles zero and negative counts', () => {
    expect(generateIds('X', 0)).toEqual([])
    expect(generateIds('X', -5)).toEqual([])
    expect(generateIds('X', 0, { sequential: true })).toEqual([])
  })

  test('caps a runaway count', () => {
    expect(generateIds('X', 99_999, { sequential: true })).toHaveLength(1000)
  })
})
