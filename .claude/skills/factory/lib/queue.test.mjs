import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderQueueMarkdown, parseQueueMarkdown } from './queue.mjs'

test('renderQueueMarkdown then parseQueueMarkdown round-trips the state', () => {
  const state = {
    cap: 3,
    generatedAt: '2026-08-20T00:00:00.000Z',
    entries: [
      { issue: 5, title: 'Fix crash on empty folder', bugOrFeature: 'bug', difficulty: 1, impact: 2, likelyFiles: ['src/main/index.ts'] }
    ],
    conflicts: []
  }
  const markdown = renderQueueMarkdown(state)
  assert.match(markdown, /# Issue Factory Queue/)
  assert.match(markdown, /#5 — bug — difficulty 1 — Fix crash on empty folder/)
  assert.deepEqual(parseQueueMarkdown(markdown), state)
})

test('parseQueueMarkdown throws a clear error when no JSON state block is present', () => {
  assert.throws(() => parseQueueMarkdown('# Issue Factory Queue\n\nnothing here\n'), /No JSON state block/)
})
