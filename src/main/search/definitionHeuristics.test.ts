import { describe, it, expect } from 'vitest'
import { looksLikeDefinition } from './definitionHeuristics'

describe('looksLikeDefinition', () => {
  it('matches a function declaration', () => {
    expect(looksLikeDefinition('function needleFunction(): string {', 'needleFunction')).toBe(true)
  })

  it('matches a class declaration', () => {
    expect(looksLikeDefinition('export class Needle {', 'Needle')).toBe(true)
  })

  it('matches a const assignment', () => {
    expect(looksLikeDefinition('const needle = 5', 'needle')).toBe(true)
  })

  it('matches a python def', () => {
    expect(looksLikeDefinition('def needle_function():', 'needle_function')).toBe(true)
  })

  it('matches a go func', () => {
    expect(looksLikeDefinition('func needleFunction() string {', 'needleFunction')).toBe(true)
  })

  it('matches a rust fn', () => {
    expect(looksLikeDefinition("fn needle_function() -> String {", 'needle_function')).toBe(true)
  })

  it('rejects a plain usage line', () => {
    expect(looksLikeDefinition('return needleFunction()', 'needleFunction')).toBe(false)
  })

  it('does not match a different word that merely starts with the same letters', () => {
    expect(looksLikeDefinition('function needleFunctionExtra(): string {', 'needleFunction')).toBe(false)
  })
})
