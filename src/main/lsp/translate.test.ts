import { describe, it, expect } from 'vitest'
import { join, sep } from 'path'
import { pathToFileURL } from 'url'
import { lspLocationsToSymbolLocations, languageForPath, toFileUri } from './translate'

const WIN_ROOT = ['C:', 'repo'].join(String.fromCharCode(92))
const WIN_OUT = ['D:', 'go', 'src', 'fmt', 'print.go'].join(String.fromCharCode(92))

const range = (line: number, character: number) => ({
  start: { line, character },
  end: { line, character: character + 3 }
})

describe('lspLocationsToSymbolLocations', () => {
  const root = process.platform === 'win32' ? WIN_ROOT : '/repo'
  const uriFor = (p: string) => pathToFileURL(p).toString()

  it('translates a location inside the root', () => {
    const abs = join(root, 'pkg', 'a.go')
    const out = lspLocationsToSymbolLocations({ uri: uriFor(abs), range: range(9, 4) }, root)
    expect(out).toEqual([{ path: 'pkg/a.go', absPath: abs, line: 10, column: 4 }])
  })

  it('translates a location link via targetSelectionRange', () => {
    const abs = join(root, 'b.py')
    const out = lspLocationsToSymbolLocations(
      [
        {
          targetUri: uriFor(abs),
          targetRange: range(0, 0),
          targetSelectionRange: range(19, 7)
        }
      ],
      root
    )
    expect(out).toEqual([{ path: 'b.py', absPath: abs, line: 20, column: 7 }])
  })

  it.runIf(process.platform === 'win32')('translates a windows file URI', () => {
    const out = lspLocationsToSymbolLocations(
      { uri: 'file:///c%3A/repo/a.go', range: range(0, 0) },
      WIN_ROOT
    )
    expect(out).toHaveLength(1)
    expect(out[0].absPath).toBe(WIN_ROOT + String.fromCharCode(92) + 'a.go')
    expect(out[0].path).toBe('a.go')
  })

  it('outside root keeps absolute path', () => {
    const abs = process.platform === 'win32' ? WIN_OUT : '/usr/local/go/src/fmt/print.go'
    const out = lspLocationsToSymbolLocations({ uri: uriFor(abs), range: range(1, 2) }, root)
    expect(out).toHaveLength(1)
    expect(out[0].absPath).toBe(abs)
    expect(out[0].path).toBe(abs.split(sep).join('/'))
    expect(out[0].line).toBe(2)
    expect(out[0].column).toBe(2)
  })

  it('null -> []', () => {
    expect(lspLocationsToSymbolLocations(null, root)).toEqual([])
  })

  it('dedupes identical locations', () => {
    const loc = { uri: uriFor(join(root, 'a.go')), range: range(3, 1) }
    expect(lspLocationsToSymbolLocations([loc, { ...loc }], root)).toHaveLength(1)
  })
})

describe('languageForPath', () => {
  it('maps extensions', () => {
    expect(languageForPath('x.pyi')).toBe('python')
    expect(languageForPath('x.py')).toBe('python')
    expect(languageForPath('x.go')).toBe('go')
    expect(languageForPath('x.ts')).toBeNull()
  })
})

describe('toFileUri', () => {
  it('round-trips through pathToFileURL', () => {
    const p = join(process.platform === 'win32' ? WIN_ROOT : '/repo', 'a b.go')
    expect(toFileUri(p)).toBe(pathToFileURL(p).toString())
  })
})
