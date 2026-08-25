import { describe, it, expect } from 'vitest'
import { classifyLinkHref } from './links'

const HTML_PATH = '/w/docs/index.html'
const ROOT = '/w'

describe('classifyLinkHref', () => {
  it('classifies an https link as external', () => {
    expect(classifyLinkHref('https://example.com/x', HTML_PATH, ROOT)).toEqual({
      kind: 'external',
      url: 'https://example.com/x'
    })
  })

  it('classifies an in-workspace relative link as navigate', () => {
    expect(classifyLinkHref('table.html', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/table.html'
    })
  })

  it('resolves ".." against the html file\'s own directory', () => {
    expect(classifyLinkHref('../other/page.html', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/other/page.html'
    })
  })

  it('treats a leading-slash href as workspace-root-relative', () => {
    expect(classifyLinkHref('/diagrams/erd.html', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/diagrams/erd.html'
    })
  })

  it('strips a fragment and query string before resolving', () => {
    expect(classifyLinkHref('table.html?x=1#section', HTML_PATH, ROOT)).toEqual({
      kind: 'navigate',
      absPath: '/w/docs/table.html'
    })
  })

  it('no-ops a link that resolves outside the workspace root', () => {
    expect(classifyLinkHref('../../../../etc/passwd', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops a bare fragment link', () => {
    expect(classifyLinkHref('#section', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops a mailto: link', () => {
    expect(classifyLinkHref('mailto:x@example.com', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('no-ops an empty href', () => {
    expect(classifyLinkHref('', HTML_PATH, ROOT)).toEqual({ kind: 'noop' })
  })

  it('classifies a protocol-relative link as external, not an in-workspace navigate', () => {
    expect(classifyLinkHref('//cdn.example.com/x', HTML_PATH, ROOT)).toEqual({
      kind: 'external',
      url: 'https://cdn.example.com/x'
    })
  })
})
