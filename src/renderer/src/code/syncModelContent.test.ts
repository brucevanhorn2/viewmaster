import { describe, it, expect } from 'vitest'
import { syncModelContent } from './syncModelContent'

function fake(text: string): { getValue(): string; setValue(v: string): void; sets: number } {
  const m = {
    sets: 0,
    getValue: () => text,
    setValue: (v: string) => {
      text = v
      m.sets++
    }
  }
  return m
}

describe('syncModelContent', () => {
  it('rewrites a model holding stale text', () => {
    const m = fake('old')
    expect(syncModelContent(m, 'new')).toBe(true)
    expect(m.getValue()).toBe('new')
  })
  it('leaves a matching model untouched', () => {
    const m = fake('same')
    expect(syncModelContent(m, 'same')).toBe(false)
    expect(m.sets).toBe(0)
  })
  it('ignores a missing model', () => {
    expect(syncModelContent(null, 'x')).toBe(false)
  })
})
