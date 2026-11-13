// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { createElement, act } from 'react'
import { createRoot } from 'react-dom/client'
import { useRemoteAllowance } from './remoteAllowance'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useRemoteAllowance', () => {
  it('allowance resets on file change', async () => {
    let state: [boolean, () => void] = [false, () => {}]
    const Probe = ({ p }: { p: string }): null => {
      state = useRemoteAllowance(p)
      return null
    }
    const root = createRoot(document.createElement('div'))
    await act(async () => root.render(createElement(Probe, { p: '/a.md' })))
    expect(state[0]).toBe(false)
    await act(async () => state[1]())
    expect(state[0]).toBe(true)
    await act(async () => root.render(createElement(Probe, { p: '/a.md' })))
    expect(state[0]).toBe(true) // same file (e.g. refresh / mode switch)
    await act(async () => root.render(createElement(Probe, { p: '/b.md' })))
    expect(state[0]).toBe(false)
    await act(async () => root.render(createElement(Probe, { p: '/a.md' })))
    expect(state[0]).toBe(false)
    act(() => root.unmount())
  })
})
