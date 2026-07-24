import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { shouldIgnore, watchRepo } from './watcher'

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

describe('watchRepo', () => {
  let dir: string
  const watchers: Array<{ close: () => void }> = []

  afterEach(() => {
    while (watchers.length) watchers.pop()!.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const nextChange = (): Promise<void> =>
    new Promise((resolve, reject) => {
      const w = watchRepo(dir, resolve)
      watchers.push(w)
      setTimeout(() => reject(new Error('no change event within timeout')), 3000)
    })

  it('fires onChange when a regular file changes', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vm-watch-'))
    const done = nextChange()
    setTimeout(() => writeFileSync(join(dir, 'README.md'), 'hello'), 100)
    await expect(done).resolves.toBeUndefined()
  })

  it('does not fire for node_modules churn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vm-watch-'))
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    let fired = false
    const w = watchRepo(dir, () => {
      fired = true
    })
    watchers.push(w)
    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'x')
    await new Promise((r) => setTimeout(r, 800))
    expect(fired).toBe(false)
  })
})
