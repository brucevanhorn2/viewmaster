import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderQueueMarkdown, parseQueueMarkdown, rankIssues, buildConflictGraph, conflictsWith } from './queue.mjs'

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

test('rankIssues sorts bugs before features, then by ascending difficulty', () => {
  const entries = [
    { issue: 1, title: 'a', bugOrFeature: 'feature', difficulty: 2, impact: 3, likelyFiles: [] },
    { issue: 2, title: 'b', bugOrFeature: 'bug', difficulty: 4, impact: 1, likelyFiles: [] },
    { issue: 3, title: 'c', bugOrFeature: 'bug', difficulty: 1, impact: 5, likelyFiles: [] }
  ]
  assert.deepEqual(rankIssues(entries).map((e) => e.issue), [3, 2, 1])
})

test('rankIssues breaks a difficulty tie by higher impact first', () => {
  const entries = [
    { issue: 10, title: 'low impact', bugOrFeature: 'bug', difficulty: 2, impact: 1, likelyFiles: [] },
    { issue: 11, title: 'high impact', bugOrFeature: 'bug', difficulty: 2, impact: 5, likelyFiles: [] }
  ]
  assert.deepEqual(rankIssues(entries).map((e) => e.issue), [11, 10])
})

test('rankIssues breaks a full tie by ascending issue number', () => {
  const entries = [
    { issue: 9, title: 'a', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: [] },
    { issue: 4, title: 'b', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: [] }
  ]
  assert.deepEqual(rankIssues(entries).map((e) => e.issue), [4, 9])
})

test('buildConflictGraph flags issues that share a likely file', () => {
  const entries = [
    { issue: 1, title: 'a', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: ['src/a.ts'] },
    { issue: 2, title: 'b', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: ['src/a.ts', 'src/b.ts'] },
    { issue: 3, title: 'c', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: ['src/c.ts'] }
  ]
  assert.deepEqual(buildConflictGraph(entries), [[1, 2]])
})

test('conflictsWith returns the set of issues conflicting with a given issue', () => {
  const conflicts = [[1, 2], [2, 3]]
  assert.deepEqual(conflictsWith(conflicts, 2), new Set([1, 3]))
  assert.deepEqual(conflictsWith(conflicts, 5), new Set())
})
