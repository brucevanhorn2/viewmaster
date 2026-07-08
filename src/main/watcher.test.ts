import { describe, it, expect } from 'vitest'
import { shouldIgnore } from './watcher'

const root = '/repo'

describe('shouldIgnore', () => {
  it('ignores node_modules', () => {
    expect(shouldIgnore(root, '/repo/node_modules/react/index.js')).toBe(true)
    expect(shouldIgnore(root, '/repo/packages/app/node_modules/x.js')).toBe(true)
  })

  it('watches regular project files', () => {
    expect(shouldIgnore(root, '/repo/src/app.ts')).toBe(false)
    expect(shouldIgnore(root, '/repo/README.md')).toBe(false)
  })

  it('watches the git refs that signal commits/stages/branch switches', () => {
    expect(shouldIgnore(root, '/repo/.git')).toBe(false)
    expect(shouldIgnore(root, '/repo/.git/HEAD')).toBe(false)
    expect(shouldIgnore(root, '/repo/.git/index')).toBe(false)
    expect(shouldIgnore(root, '/repo/.git/refs/heads/main')).toBe(false)
  })

  it('ignores noisy .git internals', () => {
    expect(shouldIgnore(root, '/repo/.git/objects/ab/cdef123')).toBe(true)
    expect(shouldIgnore(root, '/repo/.git/hooks/pre-commit.sample')).toBe(true)
    expect(shouldIgnore(root, '/repo/.git/logs/HEAD')).toBe(true)
  })
})
