import { afterEach, expect, test } from 'vitest'
import {
  gazeDeliveryGeneration,
  gazeDeliveryWarning,
  reportGazeDelivery,
  resetGazeDeliverySession,
} from './gazeDelivery'
afterEach(resetGazeDeliverySession)
test('new login/logout clears old warnings and rejects completion from the previous session', () => {
  const previous = gazeDeliveryGeneration()
  reportGazeDelivery('empty', previous)
  expect(gazeDeliveryWarning()).toBe('empty')
  resetGazeDeliverySession()
  expect(gazeDeliveryWarning()).toBeNull()
  reportGazeDelivery('upload_failed', previous)
  expect(gazeDeliveryWarning()).toBeNull()
  reportGazeDelivery('upload_failed', gazeDeliveryGeneration())
  expect(gazeDeliveryWarning()).toBe('upload_failed')
})
