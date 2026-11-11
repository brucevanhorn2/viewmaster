import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installHint, noticeText, reportResult, resetNoticeStateForTests, subscribeNotice } from './symbolNotice'

const GO_HINT = 'go install golang.org/x/tools/gopls@latest'

describe('noticeText', () => {
  it('returns the six exact labels', () => {
    expect(noticeText({ language: 'go', reason: 'starting' })).toBe('approximate — Go index still loading')
    expect(noticeText({ language: 'go', reason: 'not-installed' })).toBe('approximate — gopls not installed')
    expect(noticeText({ language: 'go', reason: 'unavailable' })).toBe('approximate — Go language server unavailable')
    expect(noticeText({ language: 'python', reason: 'starting' })).toBe('approximate — Python index still loading')
    expect(noticeText({ language: 'python', reason: 'not-installed' })).toBe(
      'approximate — Python language server unavailable'
    )
    expect(noticeText({ language: 'python', reason: 'unavailable' })).toBe(
      'approximate — Python language server unavailable'
    )
  })
})

describe('installHint', () => {
  it('is only for go/not-installed', () => {
    expect(installHint({ language: 'go', reason: 'not-installed' })).toBe(GO_HINT)
    expect(installHint({ language: 'go', reason: 'starting' })).toBeNull()
    expect(installHint({ language: 'go', reason: 'unavailable' })).toBeNull()
    expect(installHint({ language: 'python', reason: 'not-installed' })).toBeNull()
    expect(installHint({ language: 'python', reason: 'unavailable' })).toBeNull()
  })
})

describe('reportResult', () => {
  let unsub: () => void
  let seen: Array<{ text: string; hint: string | null } | null>
  beforeEach(() => {
    resetNoticeStateForTests()
    seen = []
    unsub = subscribeNotice((n) => seen.push(n))
  })

  afterEach(() => unsub())

  it('emits nothing for results without approximate', () => {
    reportResult({ locations: [], truncated: false })
    expect(seen).toEqual([])
  })

  it('a real (lsp) answer clears an earlier approximate notice', () => {
    reportResult({ locations: [], truncated: false, source: 'lsp' })
    expect(seen).toEqual([null])
  })

  it('includes the hint on the first go/not-installed result and null on the second', () => {
    const r = { locations: [], truncated: false, source: 'heuristic' as const, approximate: { language: 'go' as const, reason: 'not-installed' as const } }
    reportResult(r)
    reportResult(r)
    expect(seen).toEqual([
      { text: 'approximate — gopls not installed', hint: GO_HINT },
      { text: 'approximate — gopls not installed', hint: null }
    ])
  })

  it('does not consume the hint when nobody is subscribed', () => {
    const r = { locations: [], truncated: false, source: 'heuristic' as const, approximate: { language: 'go' as const, reason: 'not-installed' as const } }
    unsub()
    reportResult(r) // no subscriber: the hint is not "shown"
    const got: unknown[] = []
    const off = subscribeNotice((n) => got.push(n))
    reportResult(r)
    reportResult(r)
    off()
    expect(got).toEqual([
      { text: 'approximate — gopls not installed', hint: GO_HINT },
      { text: 'approximate — gopls not installed', hint: null }
    ])
  })

  it('unsubscribe stops delivery', () => {
    const got: unknown[] = []
    const off = subscribeNotice((n) => got.push(n))
    off()
    reportResult({ locations: [], truncated: false, approximate: { language: 'python', reason: 'starting' } })
    expect(got).toEqual([])
    expect(seen).toHaveLength(1)
  })
})
