import { describe, it, expect } from 'vitest'
import { repoId, pathHash, historyPaths } from './paths'

describe('history paths', () => {
  it('repoId is deterministic and 16 hex chars', () => {
    const a = repoId('/Users/x/repo')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(repoId('/Users/x/repo')).toBe(a)
    expect(repoId('/Users/x/other')).not.toBe(a)
  })

  it('pathHash is deterministic per relPath', () => {
    expect(pathHash('src/app.ts')).toBe(pathHash('src/app.ts'))
    expect(pathHash('src/app.ts')).not.toBe(pathHash('src/other.ts'))
  })

  it('lays out dirs under baseDir/history/<repoId>', () => {
    const p = historyPaths('/base', '/Users/x/repo')
    const id = repoId('/Users/x/repo')
    expect(p.repoDir).toBe(`/base/history/${id}`)
    expect(p.objectsDir).toBe(`/base/history/${id}/objects`)
    expect(p.logsDir).toBe(`/base/history/${id}/logs`)
    expect(p.stateFile).toBe(`/base/history/${id}/state.json`)
    expect(p.logFile('src/app.ts')).toBe(`/base/history/${id}/logs/${pathHash('src/app.ts')}.jsonl`)
  })
})
