import { describe, it, expect } from 'vitest'
import { looksLikeImportOf } from './importHeuristics'

describe('looksLikeImportOf', () => {
  it('matches a TS/JS import-from statement', () => {
    expect(looksLikeImportOf("import { foo } from './utils'", 'utils')).toBe(true)
  })

  it('matches a require call', () => {
    expect(looksLikeImportOf("const u = require('./utils')", 'utils')).toBe(true)
  })

  it('matches a Python from-import statement', () => {
    expect(looksLikeImportOf('from myapp.utils import foo', 'utils')).toBe(true)
  })

  it('matches a Python bare import statement', () => {
    expect(looksLikeImportOf('import myapp.utils', 'utils')).toBe(true)
  })

  it('matches a Go import statement', () => {
    expect(looksLikeImportOf('import "myapp/pkg/utils"', 'utils')).toBe(true)
  })

  it('rejects a plain usage line', () => {
    expect(looksLikeImportOf('return utils.formatDate()', 'utils')).toBe(false)
  })

  it('rejects a comment merely mentioning the name', () => {
    expect(looksLikeImportOf('// this relates to utils somehow', 'utils')).toBe(false)
  })
})
