import { describe, it, expect } from 'vitest'
import {
  initialNavigationState,
  pushEntry,
  goBack,
  goForward,
  canGoBack,
  canGoForward,
  currentEntry
} from './history'

describe('navigation history', () => {
  it('starts empty with no current entry', () => {
    const state = initialNavigationState()
    expect(currentEntry(state)).toBeNull()
    expect(canGoBack(state)).toBe(false)
    expect(canGoForward(state)).toBe(false)
  })

  it('pushing an entry makes it current and enables back but not forward', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    expect(currentEntry(state)).toEqual({ absPath: '/a.md' })
    expect(canGoBack(state)).toBe(false)
    expect(canGoForward(state)).toBe(false)

    state = pushEntry(state, { absPath: '/b.md' })
    expect(currentEntry(state)).toEqual({ absPath: '/b.md' })
    expect(canGoBack(state)).toBe(true)
    expect(canGoForward(state)).toBe(false)
  })

  it('goBack/goForward move the position without duplicating entries', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    state = pushEntry(state, { absPath: '/b.md' })
    state = pushEntry(state, { absPath: '/c.md' })

    state = goBack(state)
    expect(currentEntry(state)).toEqual({ absPath: '/b.md' })
    expect(canGoBack(state)).toBe(true)
    expect(canGoForward(state)).toBe(true)

    state = goBack(state)
    expect(currentEntry(state)).toEqual({ absPath: '/a.md' })
    expect(canGoBack(state)).toBe(false)
    expect(canGoForward(state)).toBe(true)

    state = goForward(state)
    state = goForward(state)
    expect(currentEntry(state)).toEqual({ absPath: '/c.md' })
    expect(canGoForward(state)).toBe(false)
  })

  it('is a no-op at either boundary', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    const afterForwardAtEnd = goForward(state)
    expect(afterForwardAtEnd).toEqual(state)

    state = goBack(state)
    const afterBackAtStart = goBack(state)
    expect(afterBackAtStart).toEqual(state)
  })

  it('a new push after going back truncates the forward entries', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md' })
    state = pushEntry(state, { absPath: '/b.md' })
    state = goBack(state)
    state = pushEntry(state, { absPath: '/c.md' })
    expect(state.entries.map((e) => e.absPath)).toEqual(['/a.md', '/c.md'])
    expect(canGoForward(state)).toBe(false)
  })

  it('carries an optional navigation target on an entry', () => {
    let state = initialNavigationState()
    state = pushEntry(state, { absPath: '/a.md', target: { kind: 'anchor', id: 'section' } })
    expect(currentEntry(state)).toEqual({
      absPath: '/a.md',
      target: { kind: 'anchor', id: 'section' }
    })
  })
})
