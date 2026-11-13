import { describe, expect, it } from 'vitest'
import { externalLabel } from './externalLabel'

describe('externalLabel', () => {
  it('labels each external kind', () => {
    expect(externalLabel('go-stdlib')).toBe('Go standard library')
    expect(externalLabel('go-modcache')).toBe('Go module cache')
    expect(externalLabel('python-packages')).toBe('Python packages')
    expect(externalLabel('go-workspace')).toBe('Go workspace module')
    expect(externalLabel('python-stubs')).toBe('Python stubs')
  })
})
