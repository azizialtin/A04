import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { DRAFT_PREFIX, clearAllDrafts, clearDraft, useLocalDraft } from './useLocalDraft'

afterEach(() => window.localStorage.clear())

describe('useLocalDraft', () => {
  it('starts empty and keeps what is typed', () => {
    const { result } = renderHook(() => useLocalDraft('diagnosis.T-1.7'))
    expect(result.current[0]).toBe('')

    act(() => result.current[1]('the loop bound is off'))
    expect(result.current[0]).toBe('the loop bound is off')
    expect(window.localStorage.getItem(`${DRAFT_PREFIX}diagnosis.T-1.7`)).toBe(
      'the loop bound is off',
    )
  })

  it('survives a remount, which is the whole point', () => {
    const first = renderHook(() => useLocalDraft('diagnosis.T-1.7'))
    act(() => first.result.current[1]('half an answer'))
    first.unmount()

    const second = renderHook(() => useLocalDraft('diagnosis.T-1.7'))
    expect(second.result.current[0]).toBe('half an answer')
  })

  it('keeps cases apart', () => {
    const one = renderHook(() => useLocalDraft('diagnosis.T-1.7'))
    act(() => one.result.current[1]('case seven'))

    const two = renderHook(() => useLocalDraft('diagnosis.T-1.8'))
    expect(two.result.current[0]).toBe('')
  })

  it('clears once the text is submitted', () => {
    const { result } = renderHook(() => useLocalDraft('diagnosis.T-1.7'))
    act(() => result.current[1]('submitted'))
    act(() => result.current[2]())

    expect(result.current[0]).toBe('')
    expect(window.localStorage.getItem(`${DRAFT_PREFIX}diagnosis.T-1.7`)).toBeNull()
  })
})

describe('clearing drafts', () => {
  it('clearDraft removes only its own', () => {
    window.localStorage.setItem(`${DRAFT_PREFIX}a`, 'one')
    window.localStorage.setItem(`${DRAFT_PREFIX}b`, 'two')

    clearDraft('a')

    expect(window.localStorage.getItem(`${DRAFT_PREFIX}a`)).toBeNull()
    expect(window.localStorage.getItem(`${DRAFT_PREFIX}b`)).toBe('two')
  })

  it('clearAllDrafts leaves the session token alone', () => {
    window.localStorage.setItem(`${DRAFT_PREFIX}a`, 'one')
    window.localStorage.setItem(`${DRAFT_PREFIX}b`, 'two')
    window.localStorage.setItem('a04_lang', 'de')

    clearAllDrafts()

    expect(window.localStorage.getItem(`${DRAFT_PREFIX}a`)).toBeNull()
    expect(window.localStorage.getItem(`${DRAFT_PREFIX}b`)).toBeNull()
    expect(window.localStorage.getItem('a04_lang')).toBe('de')
  })
})
