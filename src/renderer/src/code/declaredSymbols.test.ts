// src/renderer/src/code/declaredSymbols.test.ts
import { describe, it, expect } from 'vitest'
import { extractDeclaredNames } from './declaredSymbols'

describe('extractDeclaredNames', () => {
  it('extracts a function declaration name', () => {
    expect(extractDeclaredNames('function needleFunction(): string {')).toEqual(['needleFunction'])
  })

  it('extracts a class declaration name', () => {
    expect(extractDeclaredNames('export class Needle {')).toEqual(['Needle'])
  })

  it('extracts a const assignment name', () => {
    expect(extractDeclaredNames('const needle = 5')).toEqual(['needle'])
  })

  it('extracts a python def name', () => {
    expect(extractDeclaredNames('def needle_function():')).toEqual(['needle_function'])
  })

  it('extracts a go func name', () => {
    expect(extractDeclaredNames('func NeedleFunction() string {')).toEqual(['NeedleFunction'])
  })

  it('extracts multiple distinct names across lines, deduplicated', () => {
    const content = 'function a() {}\nfunction b() {}\nfunction a() {}\n'
    expect(extractDeclaredNames(content)).toEqual(['a', 'b'])
  })

  it('returns an empty array for a file with no declarations', () => {
    expect(extractDeclaredNames('return a + b\nconsole.log("hi")\n')).toEqual([])
  })

  it('does not extract a declaration nested inside a function body', () => {
    const content = 'function outer() {\n  const inner = 1\n  return inner\n}\n'
    expect(extractDeclaredNames(content)).toEqual(['outer'])
  })

  it('extracts an exported top-level declaration', () => {
    expect(extractDeclaredNames('export const needle = 5')).toEqual(['needle'])
  })

  it('extracts an export default function declaration', () => {
    expect(extractDeclaredNames('export default function RelatedFilesPane({')).toEqual([
      'RelatedFilesPane'
    ])
  })

  it('extracts an export default class declaration', () => {
    expect(extractDeclaredNames('export default class Foo {')).toEqual(['Foo'])
  })

  it('extracts an export abstract class declaration', () => {
    expect(extractDeclaredNames('export abstract class Bar {')).toEqual(['Bar'])
  })

  it('extracts an export async function declaration', () => {
    expect(extractDeclaredNames('export async function baz() {}')).toEqual(['baz'])
  })

  it('extracts a bare top-level async function declaration', () => {
    expect(extractDeclaredNames('async function baz() {}')).toEqual(['baz'])
  })
})
