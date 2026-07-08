import { describe, it, expect } from 'vitest'
import { buildTree } from './tree'
import type { ChangedFile } from './types'

function file(path: string): ChangedFile {
  return { path, absPath: `/repo/${path}`, status: 'modified' }
}

describe('buildTree', () => {
  it('returns an empty root for no files', () => {
    const root = buildTree([])
    expect(root).toEqual({ name: '', path: '', dirs: [], files: [] })
  })

  it('puts root-level files on the root node', () => {
    const root = buildTree([file('README.md')])
    expect(root.dirs).toEqual([])
    expect(root.files.map((f) => f.path)).toEqual(['README.md'])
  })

  it('nests directories and contains only dirs with changes', () => {
    const root = buildTree([file('src/main/git/run.ts'), file('src/shared/types.ts')])
    expect(root.files).toEqual([])
    expect(root.dirs.map((d) => d.name)).toEqual(['src'])
    const src = root.dirs[0]
    expect(src.path).toBe('src')
    expect(src.dirs.map((d) => d.name)).toEqual(['main', 'shared'])
    const main = src.dirs[0]
    expect(main.dirs.map((d) => d.path)).toEqual(['src/main/git'])
    expect(main.dirs[0].files.map((f) => f.path)).toEqual(['src/main/git/run.ts'])
  })

  it('sorts dirs before files, both alphabetically', () => {
    const root = buildTree([file('zeta.txt'), file('alpha/inner.txt'), file('beta.txt')])
    expect(root.dirs.map((d) => d.name)).toEqual(['alpha'])
    expect(root.files.map((f) => f.path)).toEqual(['beta.txt', 'zeta.txt'])
  })
})
