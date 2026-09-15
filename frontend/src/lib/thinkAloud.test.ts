import { expect, test } from 'vitest'

import { thinkAloudBlocks } from './thinkAloud'

test('one per case is the default shape', () => {
  expect(thinkAloudBlocks(7, 1)).toEqual([1, 1, 1, 1, 1, 1, 1])
})

test('the last block is short when the size does not divide the phase', () => {
  expect(thinkAloudBlocks(7, 3)).toEqual([3, 3, 1])
  expect(thinkAloudBlocks(6, 3)).toEqual([3, 3])
})

test('a block larger than the phase is the whole phase', () => {
  expect(thinkAloudBlocks(7, 20)).toEqual([7])
})

test('nothing to show without training videos, and a junk size reads as one', () => {
  expect(thinkAloudBlocks(0, 3)).toEqual([])
  expect(thinkAloudBlocks(3, 0)).toEqual([1, 1, 1])
  expect(thinkAloudBlocks(3, Number.NaN)).toEqual([1, 1, 1])
})
