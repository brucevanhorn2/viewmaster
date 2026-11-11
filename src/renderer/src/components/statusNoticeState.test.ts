import { describe, expect, it } from 'vitest'
import { LONG_MS, SHORT_MS, nextNotice, type ShownNotice } from './statusNoticeState'

const HINT = 'go install golang.org/x/tools/gopls@latest'
const withHint = { text: 'approximate — gopls not installed', hint: HINT }
const plain = { text: 'approximate — Python index still loading', hint: null }

describe('nextNotice', () => {
  it('shows a plain notice for SHORT_MS and a hint notice for LONG_MS', () => {
    expect(nextNotice(null, plain, 1000)).toEqual({ notice: plain, until: 1000 + SHORT_MS })
    expect(nextNotice(null, withHint, 1000)).toEqual({ notice: withHint, until: 1000 + LONG_MS })
  })

  it('a later plain notice replaces a plain one and restarts its timer', () => {
    const cur: ShownNotice = { notice: plain, until: 1000 + SHORT_MS }
    const other = { text: 'approximate — Go index still loading', hint: null }
    expect(nextNotice(cur, other, 2000)).toEqual({ notice: other, until: 2000 + SHORT_MS })
  })

  it('a plain notice keeps a showing hint, updates the text, and keeps its deadline', () => {
    const cur: ShownNotice = { notice: withHint, until: 1000 + LONG_MS }
    const next = nextNotice(cur, plain, 3000)
    expect(next).toEqual({ notice: { text: plain.text, hint: HINT }, until: 1000 + LONG_MS })
  })

  it('once the hint has expired a plain notice replaces it', () => {
    const cur: ShownNotice = { notice: withHint, until: 1000 + LONG_MS }
    expect(nextNotice(cur, plain, 1000 + LONG_MS)).toEqual({ notice: plain, until: 1000 + LONG_MS + SHORT_MS })
  })

  it('null clears', () => {
    expect(nextNotice({ notice: withHint, until: 9999 }, null, 0)).toBeNull()
  })
})
