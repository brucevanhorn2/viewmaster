import { describe, it, expect } from 'vitest'
import { getPathArgFromArgv } from './argv'

describe('getPathArgFromArgv', () => {
  it('extracts a path argument from packaged-mode argv', () => {
    expect(getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master', '/some/path'], true)).toBe(
      '/some/path'
    )
  })

  it('extracts a path argument from dev-mode argv (electron binary + entry-point arg both skipped)', () => {
    expect(getPathArgFromArgv(['/usr/local/bin/electron', '.', '/some/path'], false)).toBe('/some/path')
  })

  it('returns null when no path argument is present (packaged)', () => {
    expect(getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master'], true)).toBeNull()
  })

  it('returns null when no path argument is present (dev)', () => {
    expect(getPathArgFromArgv(['/usr/local/bin/electron', '.'], false)).toBeNull()
  })

  it('returns null when only flag-like arguments are present', () => {
    expect(getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master', '--foo'], true)).toBeNull()
  })

  it('skips a flag that appears before the real path argument', () => {
    expect(
      getPathArgFromArgv(['/Applications/View Master.app/Contents/MacOS/View Master', '--foo', '/some/path'], true)
    ).toBe('/some/path')
  })

  it("skips macOS's -psn_ process-serial-number argument the same way as any other flag", () => {
    expect(
      getPathArgFromArgv(
        ['/Applications/View Master.app/Contents/MacOS/View Master', '-psn_0_12345', '/some/path'],
        true
      )
    ).toBe('/some/path')
  })
})
