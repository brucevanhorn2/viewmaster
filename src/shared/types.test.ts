import { describe, it, expect } from 'vitest'
import { STATUS_PRIORITY } from './types'

describe('shared types', () => {
  it('orders status priority untracked > modified > staged > committed', () => {
    expect(STATUS_PRIORITY).toEqual(['untracked', 'modified', 'staged', 'committed'])
  })
})
