# Issue Factory Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the `/factory` dispatcher skill that triages viewmaster's open GitHub issues, runs their plan+execution stages concurrently (capped) in worktrees, and gates pushing and merging behind explicit human commands.

**Architecture:** A single skill, `.claude/skills/factory/SKILL.md`, dispatches on `/factory <verb>`. Deterministic/mechanical work (ranking, conflict detection, queue.md serialization, `gh`/`git` calls) lives in a small dependency-free Node CLI (`driver.mjs` + `lib/`) that `SKILL.md` shells out to. Judgment work (reading issues, brainstorming, writing plans, executing plans, reviewing code) stays with Claude and the existing `brainstorming`/`writing-plans`/`subagent-driven-development`/`code-review` skills — this plan only builds the scheduler around them, never reimplements them.

**Tech Stack:** Plain Node.js (v22, ESM, no new npm dependencies), `gh` CLI, `git` CLI, Node's built-in `node:test` runner.

**Spec:** `docs/superpowers/specs/2026-08-20-issue-factory-design.md`

## Global Constraints

- Exactly one `factory:*` label on an issue at a time — labels are the pipeline-stage source of truth, not a database.
- The `factory:executing` concurrency cap defaults to 3, overridable via `/factory triage --cap N`. Brainstorming is never capped — a brainstormed-and-planned issue that can't get a free execution slot yet is labeled `factory:plan-ready` and drained into `factory:executing` by a later `/factory next` or `/factory push-done` call, never by a background watcher.
- Every push — including code-review fix-round commits — is run by the human. Claude only ever prints the exact `git push` command; nothing in this plan ever runs `git push`.
- Merge is always a separate human action. Nothing in this plan runs `gh pr merge`.
- A code-review loop that hasn't converged after 3 rounds stops and relabels `factory:needs-attention` instead of looping.
- `.claude/factory/` is local working state only, excluded via `.git/info/exclude` (the same mechanism already used for `.claude/worktrees/`), never committed.
- No new npm dependencies. `driver.mjs` uses only Node built-ins plus the already-available `gh`/`git` CLIs.
- Every `driver.mjs` subcommand that shells out uses `execFileSync`/`spawnSync` with array args — never a string-interpolated shell command — to avoid injection.

---

### Task 1: Repo scaffolding

**Files:**
- Create: `.claude/skills/factory/` (directory)
- Create: `.claude/skills/factory/lib/` (directory)
- Modify: `.git/info/exclude`

**Interfaces:**
- Produces: the directory layout every later task writes into, and the `.claude/factory/` exclusion every later task relies on for "state is never committed."

- [ ] **Step 1: Create the skill directories**

```bash
mkdir -p .claude/skills/factory/lib
```

- [ ] **Step 2: Exclude the runtime state directory**

Append to `.git/info/exclude` (it already excludes `**/.claude/worktrees/` the same way):

```
**/.claude/factory/
```

- [ ] **Step 3: Verify**

```bash
mkdir -p .claude/factory && touch .claude/factory/.tmp-check
git check-ignore -v .claude/factory/.tmp-check
rm -rf .claude/factory
```

Expected: `git check-ignore` prints a match against `.git/info/exclude`, confirming the directory will never be accidentally committed.

- [ ] **Step 4: Commit**

```bash
git add .git/info/exclude
git commit -m "chore: scaffold factory skill directories, exclude runtime state"
```

(The empty `.claude/skills/factory/` and `lib/` directories aren't tracked by git until they contain files — later tasks add those files to this same area.)

---

### Task 2: Label constants and label-transition logic

**Files:**
- Create: `.claude/skills/factory/lib/labels.mjs`
- Test: `.claude/skills/factory/lib/labels.test.mjs`

**Interfaces:**
- Produces: `FACTORY_LABELS: string[]`, `isFactoryLabel(name: string): boolean`, `computeLabelTransition(currentLabels: string[], newLabel: string): { toRemove: string[], toAdd: string[] }`. Consumed by `driver.mjs`'s `set-label` command (Task 7).

- [ ] **Step 1: Write the failing tests**

```js
// .claude/skills/factory/lib/labels.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { FACTORY_LABELS, isFactoryLabel, computeLabelTransition } from './labels.mjs'

test('FACTORY_LABELS has exactly the 8 expected stage labels', () => {
  assert.deepEqual(FACTORY_LABELS, [
    'factory:queued',
    'factory:brainstorming',
    'factory:plan-ready',
    'factory:executing',
    'factory:awaiting-push',
    'factory:in-review',
    'factory:ready-to-merge',
    'factory:needs-attention'
  ])
})

test('isFactoryLabel only matches factory: prefixed labels', () => {
  assert.equal(isFactoryLabel('factory:queued'), true)
  assert.equal(isFactoryLabel('bug'), false)
})

test('computeLabelTransition removes the old factory label and adds the new one', () => {
  const result = computeLabelTransition(['bug', 'factory:queued'], 'factory:brainstorming')
  assert.deepEqual(result, { toRemove: ['factory:queued'], toAdd: ['factory:brainstorming'] })
})

test('computeLabelTransition is a no-op when the issue already has the target label', () => {
  const result = computeLabelTransition(['factory:executing'], 'factory:executing')
  assert.deepEqual(result, { toRemove: [], toAdd: [] })
})

test('computeLabelTransition leaves non-factory labels untouched', () => {
  const result = computeLabelTransition(['bug', 'help wanted'], 'factory:queued')
  assert.deepEqual(result, { toRemove: [], toAdd: ['factory:queued'] })
})

test('computeLabelTransition rejects a non-factory target label', () => {
  assert.throws(() => computeLabelTransition([], 'bug'), /Not a factory label/)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .claude/skills/factory/lib/labels.test.mjs`
Expected: FAIL — `labels.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// .claude/skills/factory/lib/labels.mjs
export const FACTORY_LABELS = [
  'factory:queued',
  'factory:brainstorming',
  'factory:plan-ready',
  'factory:executing',
  'factory:awaiting-push',
  'factory:in-review',
  'factory:ready-to-merge',
  'factory:needs-attention'
]

export function isFactoryLabel(name) {
  return FACTORY_LABELS.includes(name)
}

export function computeLabelTransition(currentLabels, newLabel) {
  if (!isFactoryLabel(newLabel)) {
    throw new Error(`Not a factory label: ${newLabel}`)
  }
  const toRemove = currentLabels.filter((l) => isFactoryLabel(l) && l !== newLabel)
  const toAdd = currentLabels.includes(newLabel) ? [] : [newLabel]
  return { toRemove, toAdd }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .claude/skills/factory/lib/labels.test.mjs`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/factory/lib/labels.mjs .claude/skills/factory/lib/labels.test.mjs
git commit -m "feat(factory): add factory label constants and transition logic"
```

---

### Task 3: Queue markdown serialization (render/parse round-trip)

**Files:**
- Create: `.claude/skills/factory/lib/queue.mjs`
- Test: `.claude/skills/factory/lib/queue.test.mjs`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `renderQueueMarkdown(state): string` and `parseQueueMarkdown(text): object`, where `state` is `{ cap: number, generatedAt: string, entries: Entry[], conflicts: [number, number][] }` and `Entry` is `{ issue: number, title: string, bugOrFeature: 'bug'|'feature', difficulty: number, impact: number, likelyFiles: string[] }`. Consumed by `driver.mjs`'s `render-queue`/`parse-queue`/`write-queue`/`next-issue` commands (Tasks 6-7) and by `rankIssues` (Task 4, added to this same file).

- [ ] **Step 1: Write the failing test**

```js
// .claude/skills/factory/lib/queue.test.mjs
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test .claude/skills/factory/lib/queue.test.mjs`
Expected: FAIL — `queue.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// .claude/skills/factory/lib/queue.mjs
const FENCE_START = '```json'
const FENCE_END = '```'

export function renderQueueMarkdown(state) {
  const { cap, generatedAt, entries, conflicts } = state
  const stateBlock = JSON.stringify({ cap, generatedAt, entries, conflicts }, null, 2)
  const orderedList = entries
    .map((e, i) => `${i + 1}. #${e.issue} — ${e.bugOrFeature} — difficulty ${e.difficulty} — ${e.title}`)
    .join('\n')
  return `# Issue Factory Queue

_Generated by \`/factory triage\`. Do not hand-edit the JSON block below — rerun \`/factory triage\` instead._

## State

${FENCE_START}
${stateBlock}
${FENCE_END}

## Queue (ordered)

${orderedList || '(empty)'}
`
}

export function parseQueueMarkdown(text) {
  const startIdx = text.indexOf(FENCE_START)
  if (startIdx === -1) throw new Error('No JSON state block found in queue.md')
  const afterStart = startIdx + FENCE_START.length
  const endIdx = text.indexOf(FENCE_END, afterStart)
  if (endIdx === -1) throw new Error('Unterminated JSON state block in queue.md')
  const json = text.slice(afterStart, endIdx).trim()
  return JSON.parse(json)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test .claude/skills/factory/lib/queue.test.mjs`
Expected: PASS, 2/2.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/factory/lib/queue.mjs .claude/skills/factory/lib/queue.test.mjs
git commit -m "feat(factory): add queue.md render/parse round-trip"
```

---

### Task 4: Ranking and conflict-graph logic

**Files:**
- Modify: `.claude/skills/factory/lib/queue.mjs`
- Modify: `.claude/skills/factory/lib/queue.test.mjs`

**Interfaces:**
- Consumes: the `Entry` shape from Task 3.
- Produces: `rankIssues(entries: Entry[]): Entry[]` (bugs before features, then ascending difficulty, then descending impact as tiebreak, then ascending issue number for determinism), `buildConflictGraph(entries: Entry[]): [number, number][]` (pairs sharing at least one `likelyFiles` entry), `conflictsWith(conflicts: [number, number][], issue: number): Set<number>`. `rankIssues` and `buildConflictGraph` are consumed by `driver.mjs`'s `rank`/`conflicts` commands (Task 6) and by `write-queue` (Task 7, which ranks before rendering). `conflictsWith` is consumed by `nextIssue` (Task 5).

- [ ] **Step 1: Write the failing tests**

Add to `.claude/skills/factory/lib/queue.test.mjs` (update the import line first):

```js
import { renderQueueMarkdown, parseQueueMarkdown, rankIssues, buildConflictGraph, conflictsWith } from './queue.mjs'
```

Then add:

```js
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
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test .claude/skills/factory/lib/queue.test.mjs`
Expected: FAIL on the 5 new tests — `rankIssues`, `buildConflictGraph`, `conflictsWith` aren't exported yet.

- [ ] **Step 3: Add the implementation**

Add to `.claude/skills/factory/lib/queue.mjs` (above the existing `renderQueueMarkdown`/`parseQueueMarkdown`):

```js
export function rankIssues(entries) {
  return [...entries].sort((a, b) => {
    const aBug = a.bugOrFeature === 'bug' ? 0 : 1
    const bBug = b.bugOrFeature === 'bug' ? 0 : 1
    if (aBug !== bBug) return aBug - bBug
    if (a.difficulty !== b.difficulty) return a.difficulty - b.difficulty
    if (a.impact !== b.impact) return b.impact - a.impact
    return a.issue - b.issue
  })
}

export function buildConflictGraph(entries) {
  const conflicts = []
  for (let i = 0; i < entries.length; i++) {
    for (let j = i + 1; j < entries.length; j++) {
      const a = entries[i]
      const b = entries[j]
      const shared = a.likelyFiles.some((f) => b.likelyFiles.includes(f))
      if (shared) conflicts.push([a.issue, b.issue])
    }
  }
  return conflicts
}

export function conflictsWith(conflicts, issue) {
  const set = new Set()
  for (const [a, b] of conflicts) {
    if (a === issue) set.add(b)
    if (b === issue) set.add(a)
  }
  return set
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .claude/skills/factory/lib/queue.test.mjs`
Expected: PASS, 7/7.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/factory/lib/queue.mjs .claude/skills/factory/lib/queue.test.mjs
git commit -m "feat(factory): add issue ranking and file-overlap conflict graph"
```

---

### Task 5: Next-issue and next-slot selection

**Files:**
- Modify: `.claude/skills/factory/lib/queue.mjs`
- Modify: `.claude/skills/factory/lib/queue.test.mjs`

**Interfaces:**
- Consumes: `conflictsWith` (Task 4).
- Produces:
  - `nextIssue(rankedEntries: Entry[], conflicts: [number, number][], live: { queuedIssues: number[], executingIssues: number[] }): number | null` — the first ranked entry that is still labeled `factory:queued` (per `live.queuedIssues`) and doesn't conflict with anything currently `factory:executing` (per `live.executingIssues`); `null` if nothing qualifies. Consumed by `driver.mjs`'s `next-issue` command (Task 7).
  - `nextSlot(planReadyIssues: number[], executingCount: number, cap: number): number | null` — if `executingCount < cap` and `planReadyIssues` is non-empty, the lowest issue number in `planReadyIssues` (FIFO by issue number, since lower-numbered issues were queued/brainstormed earlier under this plan's ranking); otherwise `null`. This is the cap-enforcement check `nextIssue` deliberately does not perform — enforcing the cap on *starting execution*, not on *brainstorming*, is what makes brainstorming uncapped per the spec. Consumed by `driver.mjs`'s `next-slot` command (Task 7).

- [ ] **Step 1: Write the failing tests**

Add to `.claude/skills/factory/lib/queue.test.mjs` (update the import line first):

```js
import { renderQueueMarkdown, parseQueueMarkdown, rankIssues, buildConflictGraph, conflictsWith, nextIssue, nextSlot } from './queue.mjs'
```

Then add:

```js
test('nextIssue picks the highest-ranked still-queued issue with no executing conflict', () => {
  const ranked = [{ issue: 1 }, { issue: 2 }, { issue: 3 }]
  const conflicts = [[2, 4]]
  const result = nextIssue(ranked, conflicts, { queuedIssues: [2, 3], executingIssues: [1] })
  assert.equal(result, 2)
})

test('nextIssue skips a queued issue that conflicts with something executing', () => {
  const ranked = [{ issue: 1 }, { issue: 2 }]
  const conflicts = [[1, 5]]
  const result = nextIssue(ranked, conflicts, { queuedIssues: [1, 2], executingIssues: [5] })
  assert.equal(result, 2)
})

test('nextIssue returns null when nothing queued is eligible', () => {
  const ranked = [{ issue: 1 }]
  const conflicts = [[1, 5]]
  const result = nextIssue(ranked, conflicts, { queuedIssues: [1], executingIssues: [5] })
  assert.equal(result, null)
})

test('nextIssue returns null when the queue is empty', () => {
  assert.equal(nextIssue([], [], { queuedIssues: [], executingIssues: [] }), null)
})

test('nextSlot returns the lowest-numbered plan-ready issue when a slot is free', () => {
  assert.equal(nextSlot([9, 4, 7], 1, 3), 4)
})

test('nextSlot returns null when the cap is already reached', () => {
  assert.equal(nextSlot([4], 3, 3), null)
})

test('nextSlot returns null when nothing is plan-ready', () => {
  assert.equal(nextSlot([], 0, 3), null)
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `node --test .claude/skills/factory/lib/queue.test.mjs`
Expected: FAIL on the 7 new tests — `nextIssue` and `nextSlot` aren't exported yet.

- [ ] **Step 3: Add the implementation**

Add to `.claude/skills/factory/lib/queue.mjs`:

```js
export function nextIssue(rankedEntries, conflicts, { queuedIssues, executingIssues }) {
  const queuedSet = new Set(queuedIssues)
  for (const entry of rankedEntries) {
    if (!queuedSet.has(entry.issue)) continue
    const blockers = conflictsWith(conflicts, entry.issue)
    const blocked = executingIssues.some((n) => blockers.has(n))
    if (!blocked) return entry.issue
  }
  return null
}

export function nextSlot(planReadyIssues, executingCount, cap) {
  if (executingCount >= cap || planReadyIssues.length === 0) return null
  return Math.min(...planReadyIssues)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .claude/skills/factory/lib/queue.test.mjs`
Expected: PASS, 14/14.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/factory/lib/queue.mjs .claude/skills/factory/lib/queue.test.mjs
git commit -m "feat(factory): add next-issue and next-slot selection over the ranked queue"
```

---

### Task 6: driver.mjs CLI skeleton and pure subcommands

**Files:**
- Create: `.claude/skills/factory/driver.mjs`
- Test: `.claude/skills/factory/driver.test.mjs`

**Interfaces:**
- Consumes: `rankIssues`, `buildConflictGraph`, `renderQueueMarkdown`, `parseQueueMarkdown` from `lib/queue.mjs` (Tasks 3-4).
- Produces: a CLI with subcommands `rank`, `conflicts`, `render-queue`, `parse-queue`, each reading JSON (or markdown, for `parse-queue`) from stdin and writing JSON (or markdown, for `render-queue`) to stdout. Consumed directly by the user/SKILL.md via `node .claude/skills/factory/driver.mjs <command>`, and by Task 7's integration commands added to this same file.

- [ ] **Step 1: Write the failing tests**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test .claude/skills/factory/driver.test.mjs`
Expected: FAIL — `driver.mjs` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
#!/usr/bin/env node
// .claude/skills/factory/driver.mjs
import { readFileSync } from 'node:fs'
import {
  rankIssues,
  buildConflictGraph,
  renderQueueMarkdown,
  parseQueueMarkdown
} from './lib/queue.mjs'

function readStdin() {
  return readFileSync(0, 'utf8')
}

const commands = {
  rank() {
    const { entries } = JSON.parse(readStdin())
    process.stdout.write(JSON.stringify(rankIssues(entries), null, 2) + '\n')
  },
  conflicts() {
    const { entries } = JSON.parse(readStdin())
    process.stdout.write(JSON.stringify(buildConflictGraph(entries), null, 2) + '\n')
  },
  'render-queue'() {
    const state = JSON.parse(readStdin())
    process.stdout.write(renderQueueMarkdown(state))
  },
  'parse-queue'() {
    const text = readStdin()
    process.stdout.write(JSON.stringify(parseQueueMarkdown(text), null, 2) + '\n')
  }
}

const [, , cmd] = process.argv
if (!cmd || !commands[cmd]) {
  process.stderr.write(`Usage: driver.mjs <${Object.keys(commands).join('|')}>\n`)
  process.exit(1)
}
commands[cmd]()
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test .claude/skills/factory/driver.test.mjs`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add .claude/skills/factory/driver.mjs .claude/skills/factory/driver.test.mjs
git commit -m "feat(factory): add driver.mjs CLI skeleton with pure subcommands"
```

---

### Task 7: driver.mjs gh/git-integration subcommands

**Files:**
- Modify: `.claude/skills/factory/driver.mjs`

**Interfaces:**
- Consumes: `FACTORY_LABELS`, `computeLabelTransition` (Task 2); `rankIssues`, `nextIssue`, `nextSlot`, `renderQueueMarkdown`, `parseQueueMarkdown` (Tasks 3-5).
- Produces: subcommands `setup-labels`, `list-open-issues`, `set-label <issue> <label>`, `create-worktree <issue> <slug>`, `create-pr <issue> <branch> <title>`, `write-queue`, `next-issue`, `next-slot`, `status`. These shell out to `gh`/`git` and touch the filesystem, so — matching this repo's existing convention for IPC-adjacent code with no test coverage (see `docs/superpowers/specs/2026-08-18-search-listing-cache-design.md`'s Testing section) — they are verified manually in Task 9, not via `node:test`.

- [ ] **Step 1: Add the integration commands**

Add to `.claude/skills/factory/driver.mjs`. First, extend the imports:

```js
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  rankIssues,
  buildConflictGraph,
  nextIssue,
  nextSlot,
  renderQueueMarkdown,
  parseQueueMarkdown
} from './lib/queue.mjs'
import { FACTORY_LABELS, computeLabelTransition } from './lib/labels.mjs'
```

Add below the imports, above `const commands = {`:

```js
const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '..', '..', '..')
const QUEUE_PATH = join(REPO_ROOT, '.claude', 'factory', 'queue.md')

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', cwd: REPO_ROOT })
}
```

Add these entries into the `commands` object, alongside the existing `rank`/`conflicts`/`render-queue`/`parse-queue`:

```js
  'write-queue'() {
    const state = JSON.parse(readStdin())
    const ranked = rankIssues(state.entries)
    const toWrite = { ...state, entries: ranked }
    mkdirSync(dirname(QUEUE_PATH), { recursive: true })
    writeFileSync(QUEUE_PATH, renderQueueMarkdown(toWrite))
    process.stdout.write(`Wrote ${QUEUE_PATH}\n`)
  },
  'next-issue'() {
    const text = readFileSync(QUEUE_PATH, 'utf8')
    const state = parseQueueMarkdown(text)
    const ranked = rankIssues(state.entries)
    const queuedIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:queued', '--state', 'open', '--json', 'number'])
    ).map((i) => i.number)
    const executingIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:executing', '--state', 'open', '--json', 'number'])
    ).map((i) => i.number)
    const chosen = nextIssue(ranked, state.conflicts, { queuedIssues, executingIssues })
    process.stdout.write(chosen === null ? 'none\n' : `${chosen}\n`)
  },
  'next-slot'() {
    const state = parseQueueMarkdown(readFileSync(QUEUE_PATH, 'utf8'))
    const planReadyIssues = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:plan-ready', '--state', 'open', '--json', 'number'])
    ).map((i) => i.number)
    const executingCount = JSON.parse(
      gh(['issue', 'list', '--label', 'factory:executing', '--state', 'open', '--json', 'number'])
    ).length
    const chosen = nextSlot(planReadyIssues, executingCount, state.cap)
    process.stdout.write(chosen === null ? 'none\n' : `${chosen}\n`)
  },
  'setup-labels'() {
    for (const label of FACTORY_LABELS) {
      try {
        gh(['label', 'create', label, '--color', 'ededed', '--force'])
        process.stdout.write(`ensured label ${label}\n`)
      } catch (err) {
        process.stderr.write(`failed to create ${label}: ${err.message}\n`)
        process.exitCode = 1
      }
    }
  },
  'list-open-issues'() {
    const all = JSON.parse(gh(['issue', 'list', '--state', 'open', '--json', 'number,title,body,url,labels']))
    const untriaged = all.filter((i) => !i.labels.some((l) => FACTORY_LABELS.includes(l.name)))
    process.stdout.write(JSON.stringify(untriaged, null, 2) + '\n')
  },
  'set-label'() {
    const [issue, newLabel] = process.argv.slice(3)
    if (!issue || !newLabel) throw new Error('usage: set-label <issue> <label>')
    const current = JSON.parse(gh(['issue', 'view', issue, '--json', 'labels'])).labels.map((l) => l.name)
    const { toRemove, toAdd } = computeLabelTransition(current, newLabel)
    if (toRemove.length || toAdd.length) {
      const args = ['issue', 'edit', issue]
      for (const l of toRemove) args.push('--remove-label', l)
      for (const l of toAdd) args.push('--add-label', l)
      gh(args)
    }
    process.stdout.write(`#${issue}: -${toRemove.join(',')} +${toAdd.join(',')}\n`)
  },
  'create-worktree'() {
    const [issue, slug] = process.argv.slice(3)
    if (!issue || !slug) throw new Error('usage: create-worktree <issue> <slug>')
    const branch = `worktree-issue-${issue}-${slug}`
    const path = join('.claude', 'worktrees', `issue-${issue}-${slug}`)
    execFileSync('git', ['worktree', 'add', path, '-b', branch], { cwd: REPO_ROOT, stdio: 'inherit' })
    process.stdout.write(`${path}\n`)
  },
  'create-pr'() {
    const [issue, branch, title] = process.argv.slice(3)
    if (!issue || !branch || !title) throw new Error('usage: create-pr <issue> <branch> <title>')
    const url = gh(['pr', 'create', '--head', branch, '--title', title, '--body', `Resolves #${issue}`]).trim()
    process.stdout.write(`${url}\n`)
  },
  status() {
    for (const label of FACTORY_LABELS) {
      const issues = JSON.parse(gh(['issue', 'list', '--label', label, '--state', 'open', '--json', 'number,title']))
      process.stdout.write(`${label} (${issues.length}):\n`)
      for (const i of issues) process.stdout.write(`  #${i.number} ${i.title}\n`)
    }
  }
```

Note `existsSync` is imported but only needed if a later change reads `QUEUE_PATH` conditionally; `next-issue` above assumes the queue exists (a clear `ENOENT` from `readFileSync` is an acceptable error for "you haven't run `/factory triage` yet").

- [ ] **Step 2: Manual verification**

```bash
node .claude/skills/factory/driver.mjs setup-labels
gh label list --repo brucevanhorn2/viewmaster | grep factory:
```

Expected: all 8 `factory:*` labels listed.

```bash
node .claude/skills/factory/driver.mjs list-open-issues
```

Expected: JSON array of the currently-open, unlabeled issues.

(Full end-to-end verification of `write-queue`, `next-issue`, `set-label`, `create-worktree`, `create-pr`, and `status` against real issue data happens in Task 9, after `SKILL.md` exists to drive them meaningfully.)

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/factory/driver.mjs
git commit -m "feat(factory): add gh/git-integration subcommands to driver.mjs"
```

---

### Task 8: SKILL.md dispatcher

**Files:**
- Create: `.claude/skills/factory/SKILL.md`

**Interfaces:**
- Consumes: every `driver.mjs` subcommand from Tasks 6-7, and the existing `superpowers:brainstorming`, `superpowers:writing-plans`, `superpowers:subagent-driven-development`, `code-review` skills by name.
- Produces: the `/factory triage|next|push-done|review|status` behavior a user invokes directly.

- [ ] **Step 1: Write SKILL.md**

```markdown
---
name: factory
description: Triage and orchestrate viewmaster's open GitHub issues across brainstorming, autonomous plan+execution in worktrees, and human-gated push/review/merge. Use when the user runs /factory <verb>.
---

# Issue Factory

Dispatcher for the pipeline described in
`docs/superpowers/specs/2026-08-20-issue-factory-design.md` — read that spec
if anything here is ambiguous; it explains *why*, this file is *exactly what
to run*.

Run every command below from the repo root
(`/home/bruce/Projects/viewmaster`) unless a worktree path is given
explicitly. The driver is `.claude/skills/factory/driver.mjs`, always
invoked as `node .claude/skills/factory/driver.mjs <command> [args]`.

Dispatch on the first word of `$ARGUMENTS`.

## `/factory triage [--cap N]`

1. `node .claude/skills/factory/driver.mjs setup-labels` (idempotent, safe every time).
2. `node .claude/skills/factory/driver.mjs list-open-issues` — untriaged open issues as JSON.
3. For each issue returned, spawn a parallel `Agent` call (`subagent_type: "Explore"`) with a prompt along these lines: "Read GitHub issue #<n> in the viewmaster repo — title: <title>, body: <body>. Skim the codebase to judge: (a) bug fix or feature/enhancement, (b) difficulty 1-5 (1 = one small well-contained file, 5 = many files/subsystems or new architecture), (c) impact 1-5, (d) the repo-relative paths it will likely touch. Reply with ONLY this JSON object, no prose: {\"issue\": <n>, \"title\": \"<title>\", \"bugOrFeature\": \"bug\"|\"feature\", \"difficulty\": <1-5>, \"impact\": <1-5>, \"likelyFiles\": [\"...\"]}."
4. Collect the results into `{ entries: [...] }`. Skip and report (don't block on) any issue whose subagent errored or returned invalid JSON.
5. `echo '<json with cap and generatedAt=now added>' | node .claude/skills/factory/driver.mjs write-queue` — `cap` from `--cap` (default 3), `generatedAt` an ISO timestamp, `conflicts` from piping the same entries through `driver.mjs conflicts` first.
6. For each entry: `node .claude/skills/factory/driver.mjs set-label <issue> factory:queued`.
7. Show the user `.claude/factory/queue.md`'s "Queue (ordered)" section.

## Slot-queue drain (used by both `/factory next` and `/factory push-done`)

Before doing anything else, both verbs below first check for waiting work:

1. `node .claude/skills/factory/driver.mjs next-slot`. If it prints an issue
   number `<m>` (not `none`): find its worktree under
   `.claude/worktrees/issue-<m>-*`, launch its background execution agent
   the same way as step 7 of `/factory next` below (same prompt shape,
   pointed at that worktree and `docs/superpowers/plans/` file), and run
   `node .claude/skills/factory/driver.mjs set-label <m> factory:executing`.
   Tell the user issue `<m>` just started executing (a slot freed up).
2. Repeat step 1 until `next-slot` prints `none` (multiple slots could be
   free at once, e.g. right after `/factory triage --cap` was lowered).
3. Continue with the verb's own steps below.

## `/factory next`

0. Run the slot-queue drain above.
1. `node .claude/skills/factory/driver.mjs next-issue`. If it prints `none`, tell the user nothing is eligible right now (empty queue, or everything queued conflicts with what's executing) and stop.
2. Otherwise it prints an issue number `<n>`. `node .claude/skills/factory/driver.mjs set-label <n> factory:brainstorming`.
3. `gh issue view <n> --json title,body,url` for the issue content.
4. Invoke `superpowers:brainstorming` against this issue interactively with the user, exactly as for any other feature request — do not skip its approval gate. This produces `docs/superpowers/specs/<date>-<slug>-design.md`.
5. Once approved, invoke `superpowers:writing-plans` to produce `docs/superpowers/plans/<date>-<slug>.md`.
6. `node .claude/skills/factory/driver.mjs create-worktree <n> <slug>` (same `<slug>` as the spec/plan filename). Note the printed `<worktree-path>`.
7. Check whether a slot is free right now: run `node .claude/skills/factory/driver.mjs next-slot` — since `<n>` isn't labeled `factory:plan-ready` yet, a non-`none` result here means some *other* plan-ready issue is owed the slot first (shouldn't normally happen right after a drain, but handles a race). If it prints `none` because the cap is genuinely full (check via `node .claude/skills/factory/driver.mjs status`, `factory:executing` count `>=` the queue's `cap`), run `node .claude/skills/factory/driver.mjs set-label <n> factory:plan-ready` and tell the user `<n>` is planned and worktree-ready, queued for the next available slot — stop here for this issue. Otherwise (a slot is genuinely free): launch a background `Agent` call (`run_in_background: true`, `subagent_type: "general-purpose"`) with a self-contained prompt stating: the absolute `<worktree-path>` to run all Bash commands from; to invoke `superpowers:subagent-driven-development` to execute `docs/superpowers/plans/<date>-<slug>.md` in full; that on completion (all tasks committed) it must NOT push, but instead print the exact `git push -u origin worktree-issue-<n>-<slug>` command, then — from the repo root, not the worktree — run `node .claude/skills/factory/driver.mjs set-label <n> factory:awaiting-push` and `gh issue comment <n> --body "Ready to push. Run: git push -u origin worktree-issue-<n>-<slug>"`; and that if it gets stuck, it must instead run `node .claude/skills/factory/driver.mjs set-label <n> factory:needs-attention` and explain why in an issue comment, rather than committing incomplete or broken work. Then run `node .claude/skills/factory/driver.mjs set-label <n> factory:executing`.
8. Tell the user what happened to `<n>` (executing now, or plan-ready and queued) and that `/factory next` is immediately safe to run again for the following issue.

## `/factory push-done <issue>`

0. Run the slot-queue drain above.
1. `gh issue view <issue> --json labels` — confirm it's currently `factory:awaiting-push`; if not, tell the user and stop.
2. `node .claude/skills/factory/driver.mjs set-label <issue> factory:in-review`.
3. Read the branch name from the worktree directory under `.claude/worktrees/issue-<issue>-*` (it's `worktree-issue-<issue>-<slug>`). `node .claude/skills/factory/driver.mjs create-pr <issue> <branch> "<title from the issue>"`.
4. Invoke `code-review` at medium effort against this PR's diff.
5. If it finds issues: address them (commit fixes in the worktree), `node .claude/skills/factory/driver.mjs set-label <issue> factory:awaiting-push`, print the push command, and stop — tell the user to push and re-run `/factory push-done <issue>`. Track review rounds for this issue across the conversation; after a 4th round still finding issues, instead run `node .claude/skills/factory/driver.mjs set-label <issue> factory:needs-attention` and tell the user review isn't converging.
6. If review is clean: `node .claude/skills/factory/driver.mjs set-label <issue> factory:ready-to-merge` and tell the user the PR is ready for them to merge.

## `/factory review <issue>`

Same as steps 4-6 of `/factory push-done` above, for re-running review on demand (e.g. after the user pushed manual changes) without a fresh push cycle.

## `/factory status`

`node .claude/skills/factory/driver.mjs status` — show the output verbatim.
```

- [ ] **Step 2: Verify the skill is discoverable**

Ask Claude Code to list available skills for this project (or check `.claude/skills/factory/SKILL.md`'s frontmatter parses — same `name`/`description` shape as the existing `.claude/skills/run-viewmaster/SKILL.md`).

- [ ] **Step 3: Commit**

```bash
git add .claude/skills/factory/SKILL.md
git commit -m "feat(factory): add /factory dispatcher skill"
```

---

### Task 9: Bootstrap the real labels

**Files:**
- None (operational step against the live `brucevanhorn2/viewmaster` GitHub repo).

**Interfaces:**
- Consumes: `setup-labels` (Task 7).
- Produces: the 8 `factory:*` labels existing on the real repo, which every later `/factory` invocation assumes are present.

- [ ] **Step 1: Run setup**

```bash
node .claude/skills/factory/driver.mjs setup-labels
```

- [ ] **Step 2: Verify**

```bash
gh label list --repo brucevanhorn2/viewmaster | grep '^factory:'
```

Expected: exactly 8 lines, one per label in `FACTORY_LABELS`.

- [ ] **Step 3: Nothing to commit**

This task only mutates GitHub label state, not the repo tree — no commit.

---

## Follow-up manual acceptance test (not a plan task)

After Task 9, from the main Claude Code session (not a dispatched implementer subagent, since `/factory triage`'s step 3 fans out its own `Agent` calls): run `/factory triage --cap 1` against the live repo and eyeball `.claude/factory/queue.md`'s ordering against your own judgment, then run `/factory next` once to confirm the brainstorming → worktree → background-execution handoff actually works end to end, before trusting it at `--cap 3` on a full backlog.
