import { describe, it, expect } from 'vitest'
import { extractImportSpecifiers, candidateImportPaths } from './resolveImports'

describe('extractImportSpecifiers', () => {
  it('extracts a default import specifier', () => {
    expect(extractImportSpecifiers("import Foo from './foo'\n")).toEqual(['./foo'])
  })

  it('extracts a named import specifier', () => {
    expect(extractImportSpecifiers("import { a, b } from '../bar'\n")).toEqual(['../bar'])
  })

  it('extracts a side-effect import with no from clause', () => {
    expect(extractImportSpecifiers("import './styles.css'\n")).toEqual(['./styles.css'])
  })

  it('extracts an export-from specifier', () => {
    expect(extractImportSpecifiers("export { a } from './a'\n")).toEqual(['./a'])
  })

  it('extracts a require specifier', () => {
    expect(extractImportSpecifiers("const x = require('./x')\n")).toEqual(['./x'])
  })

  it('includes a bare package specifier alongside a local one', () => {
    const specifiers = extractImportSpecifiers("import React from 'react'\nimport Foo from './foo'\n")
    expect(specifiers).toEqual(['react', './foo'])
  })

  it('deduplicates repeated specifiers', () => {
    expect(extractImportSpecifiers("import a from './x'\nimport b from './x'\n")).toEqual(['./x'])
  })

  it('extracts a side-effect import even when a later import has a from clause', () => {
    const content = "import './App.css'\nimport { useState } from 'react'\nimport Foo from './Foo'\n"
    expect(extractImportSpecifiers(content)).toEqual(['./App.css', 'react', './Foo'])
  })
})

describe('candidateImportPaths', () => {
  it('returns an empty list for a bare (node_modules-style) specifier', () => {
    expect(candidateImportPaths('/project/src', 'react')).toEqual([])
  })

  it('builds candidates for a relative specifier without an extension', () => {
    const candidates = candidateImportPaths('/project/src', './foo')
    expect(candidates[0]).toBe('/project/src/foo')
    expect(candidates).toContain('/project/src/foo.ts')
    expect(candidates).toContain('/project/src/foo/index.ts')
  })

  it('resolves a parent-directory specifier', () => {
    const candidates = candidateImportPaths('/project/src/components', '../util/helper')
    expect(candidates[0]).toBe('/project/src/util/helper')
  })
})
