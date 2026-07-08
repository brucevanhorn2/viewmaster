import { describe, it, expect } from 'vitest'
import { iconNameForFile } from './iconName'

describe('iconNameForFile', () => {
  it('matches exact file names first', () => {
    expect(iconNameForFile('package.json')).toBe('nodejs')
  })

  it('matches simple extensions', () => {
    expect(iconNameForFile('app.ts')).toBe('typescript')
    expect(iconNameForFile('notes.md')).toBe('markdown')
  })

  it('gives README its dedicated icon over the md extension', () => {
    expect(iconNameForFile('README.md')).toBe('readme')
  })

  it('prefers the longest compound extension', () => {
    // 'd.ts' has its own icon distinct from plain 'ts'
    expect(iconNameForFile('types.d.ts')).not.toBe('typescript')
    expect(iconNameForFile('types.d.ts')).toBe(iconNameForFile('other.d.ts'))
  })

  it('is case-insensitive on names and extensions', () => {
    expect(iconNameForFile('NOTES.MD')).toBe('markdown')
    expect(iconNameForFile('README.MD')).toBe('readme')
  })

  it('falls back to the generic file icon', () => {
    expect(iconNameForFile('mystery.zzzzz')).toBe('file')
    expect(iconNameForFile('no-extension')).toBe('file')
  })
})
