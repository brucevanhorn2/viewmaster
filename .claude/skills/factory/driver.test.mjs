// .claude/skills/factory/driver.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const DRIVER = join(__dirname, 'driver.mjs')

function run(cmd, input) {
  return execFileSync('node', [DRIVER, cmd], { input, encoding: 'utf8' })
}

test('rank sorts bugs before features via the CLI', () => {
  const entries = [
    { issue: 1, title: 'a', bugOrFeature: 'feature', difficulty: 1, impact: 1, likelyFiles: [] },
    { issue: 2, title: 'b', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: [] }
  ]
  const out = JSON.parse(run('rank', JSON.stringify({ entries })))
  assert.deepEqual(out.map((e) => e.issue), [2, 1])
})

test('conflicts reports file-overlap pairs via the CLI', () => {
  const entries = [
    { issue: 1, title: 'a', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: ['src/a.ts'] },
    { issue: 2, title: 'b', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: ['src/a.ts'] }
  ]
  const out = JSON.parse(run('conflicts', JSON.stringify({ entries })))
  assert.deepEqual(out, [[1, 2]])
})

test('render-queue then parse-queue round-trips via the CLI', () => {
  const state = {
    cap: 3,
    generatedAt: '2026-08-20T00:00:00.000Z',
    entries: [{ issue: 5, title: 'x', bugOrFeature: 'bug', difficulty: 1, impact: 1, likelyFiles: [] }],
    conflicts: []
  }
  const markdown = run('render-queue', JSON.stringify(state))
  const parsed = JSON.parse(run('parse-queue', markdown))
  assert.deepEqual(parsed, state)
})

test('an unknown command exits non-zero with a usage message on stderr', () => {
  assert.throws(() => execFileSync('node', [DRIVER, 'bogus'], { encoding: 'utf8' }))
})
