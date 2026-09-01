import { describe, it, expect } from 'vitest'
import { requiresCodeModeForLineTarget } from './lineTargetMode'

describe('requiresCodeModeForLineTarget', () => {
  it('forces code mode for a markdown file with a line target', () => {
    expect(
      requiresCodeModeForLineTarget({ isMarkdown: true, isHtml: false, hasLineTarget: true })
    ).toBe(true)
  })

  it('forces code mode for an html file with a line target', () => {
    expect(
      requiresCodeModeForLineTarget({ isMarkdown: false, isHtml: true, hasLineTarget: true })
    ).toBe(true)
  })

  it('does not force code mode for a markdown file with no line target', () => {
    expect(
      requiresCodeModeForLineTarget({ isMarkdown: true, isHtml: false, hasLineTarget: false })
    ).toBe(false)
  })

  it('does not force code mode for an html file with no line target', () => {
    expect(
      requiresCodeModeForLineTarget({ isMarkdown: false, isHtml: true, hasLineTarget: false })
    ).toBe(false)
  })

  it('does not force code mode for a non-markdown, non-html file even with a line target', () => {
    expect(
      requiresCodeModeForLineTarget({ isMarkdown: false, isHtml: false, hasLineTarget: true })
    ).toBe(false)
  })

  it('does not force code mode when neither markdown nor html nor a line target', () => {
    expect(
      requiresCodeModeForLineTarget({ isMarkdown: false, isHtml: false, hasLineTarget: false })
    ).toBe(false)
  })
})
