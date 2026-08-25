import { describe, it, expect } from 'vitest'
import { extractImportSpecifiersForLanguage, candidateImportPathsForLanguage } from './importExtractors'

describe('extractImportSpecifiersForLanguage', () => {
  it('dispatches typescript to the TS/JS extractor', () => {
    expect(extractImportSpecifiersForLanguage('typescript', "import Foo from './foo'\n")).toEqual(['./foo'])
  })

  it('dispatches javascript to the TS/JS extractor', () => {
    expect(extractImportSpecifiersForLanguage('javascript', "import Foo from './foo'\n")).toEqual(['./foo'])
  })

  it('extracts a python relative from-import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from .utils import foo\n')).toEqual(['.utils'])
  })

  it('extracts a python parent-relative from-import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from ..pkg.sub import bar\n')).toEqual(['..pkg.sub'])
  })

  it('extracts a bare-package python relative import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from . import foo\n')).toEqual(['.'])
  })

  it('ignores a python absolute dotted import', () => {
    expect(extractImportSpecifiersForLanguage('python', 'from myapp.utils import foo\n')).toEqual([])
  })

  it('returns an empty list for go', () => {
    expect(extractImportSpecifiersForLanguage('go', 'import "myapp/pkg/utils"\n')).toEqual([])
  })

  it('returns an empty list for an unrecognized language', () => {
    expect(extractImportSpecifiersForLanguage('plaintext', 'anything\n')).toEqual([])
  })
})

describe('candidateImportPathsForLanguage', () => {
  it('dispatches typescript to the TS/JS resolver', () => {
    const candidates = candidateImportPathsForLanguage('typescript', '/project/src', './foo')
    expect(candidates[0]).toBe('/project/src/foo')
    expect(candidates).toContain('/project/src/foo.ts')
  })

  it('resolves a python same-package relative import', () => {
    const candidates = candidateImportPathsForLanguage('python', '/project/pkg', '.utils')
    expect(candidates).toEqual(['/project/pkg/utils.py', '/project/pkg/utils/__init__.py'])
  })

  it('resolves a python parent-package relative import', () => {
    const candidates = candidateImportPathsForLanguage('python', '/project/pkg/sub', '..utils')
    expect(candidates).toEqual(['/project/pkg/utils.py', '/project/pkg/utils/__init__.py'])
  })

  it('resolves a python bare-package relative import (from . import x)', () => {
    const candidates = candidateImportPathsForLanguage('python', '/project/pkg', '.')
    expect(candidates).toEqual(['/project/pkg.py', '/project/pkg/__init__.py'])
  })

  it('returns an empty list for go', () => {
    expect(candidateImportPathsForLanguage('go', '/project/src', 'myapp/pkg/utils')).toEqual([])
  })
})
