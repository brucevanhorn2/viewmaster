import { describe, it, expect } from 'vitest'
import { slugify } from './slug'

describe('slugify', () => {
  it('lowercases and hyphenates spaces', () => {
    expect(slugify('Getting Started', new Map())).toBe('getting-started')
  })

  it('strips punctuation', () => {
    expect(slugify('FAQ: Common Questions!', new Map())).toBe('faq-common-questions')
  })

  it('collapses multiple spaces and trims leading/trailing hyphens', () => {
    expect(slugify('  Hello   World  ', new Map())).toBe('hello-world')
  })

  it('keeps existing hyphens and digits', () => {
    expect(slugify('Step 1 - Setup', new Map())).toBe('step-1---setup')
  })

  it('falls back to "section" for text with no sluggable characters', () => {
    expect(slugify('!!!', new Map())).toBe('section')
  })

  it('disambiguates repeated headings within the same seen map', () => {
    const seen = new Map<string, number>()
    expect(slugify('Overview', seen)).toBe('overview')
    expect(slugify('Overview', seen)).toBe('overview-1')
    expect(slugify('Overview', seen)).toBe('overview-2')
  })

  it('does not disambiguate across separate seen maps', () => {
    expect(slugify('Overview', new Map())).toBe('overview')
    expect(slugify('Overview', new Map())).toBe('overview')
  })
})
