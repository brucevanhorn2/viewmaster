import { describe, it, expect } from 'vitest'
import { classifyLinkHref } from './links'

const MD_PATH = '/w/docs/index.md'
const ROOT = '/w'

describe('classifyLinkHref', () => {
  it('classifies an https link as external', () => {
    expect(classifyLinkHref('https://example.com/x', MD_PATH, ROOT)).toEqual({
      kind: 'external',
      url: 'https://example.com/x'
    })
  })

  it('classifies a bare fragment as an anchor', () => {
    expect(classifyLinkHref('#section', MD_PATH, ROOT)).toEqual({ kind: 'anchor', id: 'section' })
  })

  it('classifies an in-workspace relative link as navigate', () => {
    expect(classifyLinkHref('other.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/other.md'
    })
  })

  it('classifies a relative link with a fragment as navigate-with-anchor', () => {
    expect(classifyLinkHref('other.md#section', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/other.md',
      anchor: 'section'
    })
  })

  it('resolves ".." against the markdown file\'s own directory', () => {
    expect(classifyLinkHref('../other/page.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/other/page.md'
    })
  })

  it('treats a leading-slash href as workspace-root-relative', () => {
    expect(classifyLinkHref('/diagrams/erd.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/diagrams/erd.md'
    })
  })

  it('strips a query string before resolving, keeping the fragment', () => {
    expect(classifyLinkHref('other.md?x=1#section', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/other.md',
      anchor: 'section'
    })
  })

  it('no-ops a link that resolves outside the workspace root', () => {
    expect(classifyLinkHref('../../../../etc/passwd', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops a mailto: link', () => {
    expect(classifyLinkHref('mailto:x@example.com', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops an empty href', () => {
    expect(classifyLinkHref('', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('percent-decodes a space in the path before resolving', () => {
    expect(classifyLinkHref('My%20Notes.md', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/My Notes.md'
    })
  })

  it('percent-decodes non-ASCII characters in both path and fragment', () => {
    expect(classifyLinkHref('%C3%BCber.md#%C3%9Cnder', MD_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/über.md',
      anchor: 'Ünder'
    })
  })

  it('percent-decodes a bare fragment anchor', () => {
    expect(classifyLinkHref('#%C3%9Cnder', MD_PATH, ROOT)).toEqual({
      kind: 'anchor',
      id: 'Ünder'
    })
  })

  it('no-ops a malformed percent-sequence instead of throwing', () => {
    expect(classifyLinkHref('bad%zzpath.md', MD_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('still blocks a percent-encoded traversal that escapes the workspace root', () => {
    expect(
      classifyLinkHref('%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd', MD_PATH, ROOT)
    ).toEqual({ kind: 'noop' })
  })
})
