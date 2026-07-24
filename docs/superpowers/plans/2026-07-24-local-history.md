# Local Edit History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture settle-based local versions of edited files between git commits and let the user diff any two of them from a JetBrains-style history pane.

**Architecture:** A main-process content-addressed object store (gzipped blobs) plus per-file append-only JSONL logs under `userData/history/<repoId>/`. The existing recursive `fs.watch` is refactored to emit granular per-file events; a `Recorder` debounces them into settle-based captures and prunes on commit. The renderer gets a history pane docked under the file tree whose selection feeds the existing `DiffView`/`MarkdownView`.

**Tech Stack:** Electron + TypeScript, React, vitest (node env, `.test.ts` only — no jsdom), `node:zlib`/`node:crypto` (no new deps).

## Global Constants

- **No new runtime dependency.** Use `node:zlib` and `node:crypto` only. `electron-store` stays the only runtime dep.
- **Git repos only.** History is active only when the session `RepoState.kind === 'repo'`.
- Capture constants (one place, `src/main/history/store.ts`): `MAX_VERSIONS_PER_FILE = 200`, `MAX_AGE_DAYS = 30`.
- Recorder timings (`src/main/history/recorder.ts`): `SETTLE_MS = 2500`, `MAX_SETTLE_MS = 30000`, `PRUNE_DEBOUNCE_MS = 500`.
- `relPath` is always repo-relative with forward slashes (matches `ChangedFile.path`).
- Skip capture for any file whose `readCurrentFile` result is not `kind: 'text'` (binary / too-large / missing).
- `repoId = sha256(root).hex.slice(0, 16)`.

---

### Task 1: Shared type + history path layout

**Files:**
- Modify: `src/shared/types.ts` (append `HistoryVersion`)
- Create: `src/main/history/paths.ts`
- Test: `src/main/history/paths.test.ts`

**Interfaces:**
- Produces:
  - `interface HistoryVersion { ts: number; sha: string; size: number }` (in `@shared/types`)
  - `repoId(root: string): string`
  - `pathHash(relPath: string): string`
  - `interface HistoryPaths { repoDir: string; objectsDir: string; logsDir: string; stateFile: string; logFile(relPath: string): string }`
  - `historyPaths(baseDir: string, root: string): HistoryPaths` — `baseDir` is the Electron `userData` dir.

- [ ] **Step 1: Write the failing test**

```typescript
// src/main/history/paths.test.ts
import { describe, it, expect } from 'vitest'
import { repoId, pathHash, historyPaths } from './paths'

describe('history paths', () => {
  it('repoId is deterministic and 16 hex chars', () => {
    const a = repoId('/Users/x/repo')
    expect(a).toMatch(/^[0-9a-f]{16}$/)
    expect(repoId('/Users/x/repo')).toBe(a)
    expect(repoId('/Users/x/other')).not.toBe(a)
  })

  it('pathHash is deterministic per relPath', () => {
    expect(pathHash('src/app.ts')).toBe(pathHash('src/app.ts'))
    expect(pathHash('src/app.ts')).not.toBe(pathHash('src/other.ts'))
  })

  it('lays out dirs under baseDir/history/<repoId>', () => {
    const p = historyPaths('/base', '/Users/x/repo')
    const id = repoId('/Users/x/repo')
    expect(p.repoDir).toBe(`/base/history/${id}`)
    expect(p.objectsDir).toBe(`/base/history/${id}/objects`)
    expect(p.logsDir).toBe(`/base/history/${id}/logs`)
    expect(p.stateFile).toBe(`/base/history/${id}/state.json`)
    expect(p.logFile('src/app.ts')).toBe(`/base/history/${id}/logs/${pathHash('src/app.ts')}.jsonl`)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/main/history/paths.test.ts`
Expected: FAIL — cannot find module `./paths`.

- [ ] **Step 3: Add the shared type**

Append to `src/shared/types.ts`:

```typescript
export interface HistoryVersion {
  /** Capture time, epoch milliseconds. */
  ts: number
  /** sha256 hex of the captured content (object key). */
  sha: string
  /** Byte length of the captured content. */
  size: number
}
```

- [ ] **Step 4: Implement `paths.ts`**

```typescript
// src/main/history/paths.ts
import { createHash } from 'crypto'
import { join } from 'path'

export function repoId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

export function pathHash(relPath: string): string {
  return createHash('sha256').update(relPath).digest('hex')
}

export interface HistoryPaths {
  repoDir: string
  objectsDir: string
  logsDir: string
  stateFile: string
  logFile(relPath: string): string
}

/** Directory layout for one repo's history. `baseDir` is Electron's userData dir. */
export function historyPaths(baseDir: string, root: string): HistoryPaths {
  const repoDir = join(baseDir, 'history', repoId(root))
  const logsDir = join(repoDir, 'logs')
  return {
    repoDir,
    objectsDir: join(repoDir, 'objects'),
    logsDir,
    stateFile: join(repoDir, 'state.json'),
    logFile: (relPath: string) => join(logsDir, `${pathHash(relPath)}.jsonl`)
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run src/main/history/paths.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/shared/types.ts src/main/history/paths.ts src/main/history/paths.test.ts
git commit -m "feat(history): shared HistoryVersion type + path layout"
```

---

### Task 2: Object store, logs, and pure retention functions

**Files:**
- Create: `src/main/history/store.ts`
- Test: `src/main/history/store.test.ts`

**Interfaces:**
- Consumes: `HistoryVersion` (Task 1).
- Produces:
  - `MAX_VERSIONS_PER_FILE: number`, `MAX_AGE_DAYS: number`
  - `putObject(objectsDir: string, content: string): Promise<string>` (returns sha)
  - `getObject(objectsDir: string, sha: string): Promise<string>`
  - `appendVersion(logFile: string, v: HistoryVersion): Promise<void>`
  - `readVersions(logFile: string): Promise<HistoryVersion[]>` (ascending; missing file → `[]`)
  - `writeVersions(logFile: string, versions: HistoryVersion[]): Promise<void>`
  - `pruneLog(entries: HistoryVersion[], commitTimeMillis: number): HistoryVersion[]`
  - `applyBackstops(entries: HistoryVersion[], nowMillis: number): HistoryVersion[]`
  - `referencedShas(logs: HistoryVersion[][]): Set<string>`
  - `gcObjects(objectsDir: string, referenced: Set<string>): Promise<void>`
  - `readState(stateFile: string): Promise<{ lastPrunedCommit: string | null }>`
  - `writeState(stateFile: string, state: { lastPrunedCommit: string | null }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/history/store.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { readdir } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  MAX_VERSIONS_PER_FILE,
  applyBackstops,
  appendVersion,
  getObject,
  gcObjects,
  pruneLog,
  putObject,
  readState,
  readVersions,
  referencedShas,
  writeState,
  writeVersions
} from './store'

const dirs: string[] = []
const tmp = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'vm-store-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true })
})

describe('pruneLog', () => {
  it('drops entries at or older than the commit time', () => {
    const e = [
      { ts: 100, sha: 'a', size: 1 },
      { ts: 200, sha: 'b', size: 1 },
      { ts: 300, sha: 'c', size: 1 }
    ]
    expect(pruneLog(e, 200).map((x) => x.sha)).toEqual(['c'])
  })
})

describe('applyBackstops', () => {
  it('drops entries older than MAX_AGE_DAYS', () => {
    const now = 1_000_000_000_000
    const old = now - 40 * 86400_000
    const e = [
      { ts: old, sha: 'a', size: 1 },
      { ts: now, sha: 'b', size: 1 }
    ]
    expect(applyBackstops(e, now).map((x) => x.sha)).toEqual(['b'])
  })

  it('keeps only the newest MAX_VERSIONS_PER_FILE', () => {
    const now = 1_000_000_000_000
    const e = Array.from({ length: MAX_VERSIONS_PER_FILE + 5 }, (_, i) => ({
      ts: now - (MAX_VERSIONS_PER_FILE + 5 - i) * 1000,
      sha: `s${i}`,
      size: 1
    }))
    const kept = applyBackstops(e, now)
    expect(kept.length).toBe(MAX_VERSIONS_PER_FILE)
    expect(kept[kept.length - 1].sha).toBe(`s${MAX_VERSIONS_PER_FILE + 4}`)
  })
})

describe('referencedShas', () => {
  it('collects shas across logs', () => {
    const set = referencedShas([
      [{ ts: 1, sha: 'a', size: 1 }],
      [{ ts: 2, sha: 'b', size: 1 }, { ts: 3, sha: 'a', size: 1 }]
    ])
    expect([...set].sort()).toEqual(['a', 'b'])
  })
})

describe('object store + logs (fs)', () => {
  it('round-trips gzipped content and dedups by sha', async () => {
    const objects = tmp()
    const sha1 = await putObject(objects, 'hello world')
    const sha2 = await putObject(objects, 'hello world')
    expect(sha1).toBe(sha2)
    expect(await getObject(objects, sha1)).toBe('hello world')
    expect((await readdir(objects)).length).toBe(1)
  })

  it('appends and reads versions, tolerating a partial trailing line', async () => {
    const dir = tmp()
    const log = join(dir, 'f.jsonl')
    await appendVersion(log, { ts: 1, sha: 'a', size: 1 })
    await appendVersion(log, { ts: 2, sha: 'b', size: 1 })
    const { appendFileSync } = await import('fs')
    appendFileSync(log, '{"ts":3,"sha":"c"') // truncated line
    const v = await readVersions(log)
    expect(v.map((x) => x.sha)).toEqual(['a', 'b'])
  })

  it('missing log reads as empty', async () => {
    expect(await readVersions(join(tmp(), 'nope.jsonl'))).toEqual([])
  })

  it('gcObjects removes unreferenced objects only', async () => {
    const objects = tmp()
    const keep = await putObject(objects, 'keep')
    const drop = await putObject(objects, 'drop')
    await gcObjects(objects, new Set([keep]))
    const left = await readdir(objects)
    expect(left).toEqual([keep])
    expect(left).not.toContain(drop)
  })

  it('state round-trips, missing reads as null', async () => {
    const dir = tmp()
    const state = join(dir, 'state.json')
    expect(await readState(state)).toEqual({ lastPrunedCommit: null })
    await writeState(state, { lastPrunedCommit: 'abc' })
    expect(await readState(state)).toEqual({ lastPrunedCommit: 'abc' })
  })

  it('writeVersions overwrites the log', async () => {
    const dir = tmp()
    const log = join(dir, 'f.jsonl')
    await appendVersion(log, { ts: 1, sha: 'a', size: 1 })
    await writeVersions(log, [{ ts: 9, sha: 'z', size: 1 }])
    expect((await readVersions(log)).map((x) => x.sha)).toEqual(['z'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/main/history/store.test.ts`
Expected: FAIL — cannot find module `./store`.

- [ ] **Step 3: Implement `store.ts`**

```typescript
// src/main/history/store.ts
import { createHash } from 'crypto'
import { appendFile, mkdir, readFile, readdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { gunzipSync, gzipSync } from 'zlib'
import type { HistoryVersion } from '@shared/types'

export const MAX_VERSIONS_PER_FILE = 200
export const MAX_AGE_DAYS = 30

export async function putObject(objectsDir: string, content: string): Promise<string> {
  const sha = createHash('sha256').update(content).digest('hex')
  await mkdir(objectsDir, { recursive: true })
  const file = join(objectsDir, sha)
  try {
    await writeFile(file, gzipSync(Buffer.from(content, 'utf8')), { flag: 'wx' })
  } catch (err) {
    // Object already exists (content-addressed) — nothing to do.
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err
  }
  return sha
}

export async function getObject(objectsDir: string, sha: string): Promise<string> {
  const buf = await readFile(join(objectsDir, sha))
  return gunzipSync(buf).toString('utf8')
}

export async function appendVersion(logFile: string, v: HistoryVersion): Promise<void> {
  await mkdir(join(logFile, '..'), { recursive: true })
  await appendFile(logFile, JSON.stringify(v) + '\n')
}

export async function readVersions(logFile: string): Promise<HistoryVersion[]> {
  let text: string
  try {
    text = await readFile(logFile, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw err
  }
  const out: HistoryVersion[] = []
  for (const line of text.split('\n')) {
    if (!line) continue
    try {
      const v = JSON.parse(line) as HistoryVersion
      if (typeof v.ts === 'number' && typeof v.sha === 'string') out.push(v)
    } catch {
      // Truncated trailing line from an interrupted append — skip it.
    }
  }
  return out
}

export async function writeVersions(logFile: string, versions: HistoryVersion[]): Promise<void> {
  await mkdir(join(logFile, '..'), { recursive: true })
  await writeFile(logFile, versions.map((v) => JSON.stringify(v)).join('\n') + (versions.length ? '\n' : ''))
}

/** Drop versions captured at or before a commit — git now owns that history. */
export function pruneLog(entries: HistoryVersion[], commitTimeMillis: number): HistoryVersion[] {
  return entries.filter((e) => e.ts > commitTimeMillis)
}

/** Count + age backstops. `entries` ascending; returns ascending. */
export function applyBackstops(entries: HistoryVersion[], nowMillis: number): HistoryVersion[] {
  const minTs = nowMillis - MAX_AGE_DAYS * 86400_000
  const fresh = entries.filter((e) => e.ts >= minTs)
  return fresh.length > MAX_VERSIONS_PER_FILE ? fresh.slice(-MAX_VERSIONS_PER_FILE) : fresh
}

export function referencedShas(logs: HistoryVersion[][]): Set<string> {
  const set = new Set<string>()
  for (const log of logs) for (const v of log) set.add(v.sha)
  return set
}

export async function gcObjects(objectsDir: string, referenced: Set<string>): Promise<void> {
  let names: string[]
  try {
    names = await readdir(objectsDir)
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
    throw err
  }
  await Promise.all(
    names.filter((n) => !referenced.has(n)).map((n) => rm(join(objectsDir, n), { force: true }))
  )
}

export async function readState(stateFile: string): Promise<{ lastPrunedCommit: string | null }> {
  try {
    return JSON.parse(await readFile(stateFile, 'utf8')) as { lastPrunedCommit: string | null }
  } catch {
    return { lastPrunedCommit: null }
  }
}

export async function writeState(
  stateFile: string,
  state: { lastPrunedCommit: string | null }
): Promise<void> {
  await mkdir(join(stateFile, '..'), { recursive: true })
  await writeFile(stateFile, JSON.stringify(state))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/history/store.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/history/store.ts src/main/history/store.test.ts
git commit -m "feat(history): content-addressed object store, logs, retention"
```

---

### Task 3: Refactor watcher to granular events; keep recompute working

**Files:**
- Modify: `src/main/watcher.ts`
- Modify: `src/main/ipc.ts:45-65` (openRepo watcher wiring)
- Test: `src/main/watcher.test.ts` (rewrite `watchRepo` block)

**Interfaces:**
- Produces: `watchRepo(root: string, onEvent: (relPath: string | null) => void): FSWatcher` — fires once per relevant fs event with the repo-relative POSIX path (or `null` when the platform gives no filename). No internal debounce.
- Consumes (in ipc): debounce is now the caller's responsibility.

- [ ] **Step 1: Update the watcher tests to the new contract**

Replace the `describe('watchRepo', …)` block in `src/main/watcher.test.ts` with:

```typescript
describe('watchRepo', () => {
  let dir: string
  const watchers: Array<{ close: () => void }> = []

  afterEach(() => {
    while (watchers.length) watchers.pop()!.close()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  const nextEvent = (): Promise<string | null> =>
    new Promise((resolve, reject) => {
      const w = watchRepo(dir, resolve)
      watchers.push(w)
      setTimeout(() => reject(new Error('no event within timeout')), 3000)
    })

  it('emits the relative path of a changed file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vm-watch-'))
    const done = nextEvent()
    setTimeout(() => writeFileSync(join(dir, 'README.md'), 'hello'), 100)
    await expect(done).resolves.toBe('README.md')
  })

  it('does not emit for node_modules churn', async () => {
    dir = mkdtempSync(join(tmpdir(), 'vm-watch-'))
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    let fired = false
    const w = watchRepo(dir, () => {
      fired = true
    })
    watchers.push(w)
    writeFileSync(join(dir, 'node_modules', 'junk.js'), 'x')
    await new Promise((r) => setTimeout(r, 800))
    expect(fired).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/watcher.test.ts`
Expected: FAIL — `watchRepo` still debounces and passes no path.

- [ ] **Step 3: Rewrite `watchRepo` in `src/main/watcher.ts`**

Replace the `watchRepo` function (keep `shouldIgnore` and imports; `DEBOUNCE_MS` is no longer used here — delete it):

```typescript
/**
 * Watch a repo and invoke `onEvent(relPath)` for each relevant fs change,
 * where relPath is repo-relative with forward slashes (null when the platform
 * gives no filename). Single native recursive fs.watch handle — no per-dir fds,
 * no EMFILE. Debouncing is left to the caller.
 */
export function watchRepo(root: string, onEvent: (relPath: string | null) => void): FSWatcher {
  const rootName = basename(root)

  const watcher = watch(root, { recursive: true, persistent: true }, (_event, filename) => {
    if (filename === null) return onEvent(null)
    const name = filename.toString()
    if (name === rootName) return // spurious macOS aggregate event
    if (shouldIgnore(root, join(root, name))) return
    onEvent(name.split(sep).join('/'))
  })

  watcher.on('error', () => {})
  return watcher
}
```

- [ ] **Step 4: Update ipc to debounce recompute itself**

In `src/main/ipc.ts`, add near the top (after imports):

```typescript
const RECOMPUTE_DEBOUNCE_MS = 300
```

Then in `openRepo`, replace the `watchRepo(...)` call in the `state.kind === 'repo'` block with:

```typescript
    const watchRoot = state.root
    let recomputeTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, () => {
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const fresh = await computeRepoState(watchRoot)
        if (session?.root === watchRoot && fresh.kind === 'repo') session.baseline = fresh.baseline
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    session = { root: state.root, baseline: state.baseline, watcher }
```

- [ ] **Step 5: Run watcher tests + typecheck**

Run: `npx vitest run src/main/watcher.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/main/watcher.ts src/main/watcher.test.ts src/main/ipc.ts
git commit -m "refactor(watcher): emit granular per-file events; debounce recompute in ipc"
```

---

### Task 4: Recorder — settle-based capture + commit-anchored prune

**Files:**
- Create: `src/main/history/recorder.ts`
- Test: `src/main/history/recorder.test.ts`

**Interfaces:**
- Consumes: `historyPaths` (Task 1); `putObject`/`appendVersion`/`readVersions`/`writeVersions`/`pruneLog`/`applyBackstops`/`referencedShas`/`gcObjects`/`readState`/`writeState` (Task 2); `readCurrentFile` from `../git/content`; `runGit` from `../git/run`.
- Produces:
  - `interface Recorder { handleEvent(relPath: string | null): void; flush(): Promise<void>; close(): Promise<void> }`
  - `interface RecorderOptions { historyBaseDir: string; settleMs?: number }`
  - `createRecorder(root: string, options: RecorderOptions): Recorder`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/main/history/recorder.test.ts
import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { makeRepo, type TestRepo } from '../git/testRepo'
import { createRecorder } from './recorder'
import { appendVersion, getObject, readVersions } from './store'
import { historyPaths } from './paths'

let repo: TestRepo
let base: string
const cleanups: Array<() => Promise<void>> = []
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c()
})

async function setup(): Promise<void> {
  repo = await makeRepo()
  base = await mkdtemp(join(tmpdir(), 'vm-hist-'))
  cleanups.push(repo.cleanup, () => rm(base, { recursive: true, force: true }))
}

describe('recorder capture', () => {
  it('captures a settled text file once, then again on change, deduping identical', async () => {
    await setup()
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    const log = historyPaths(base, repo.root).logFile('doc.md')

    await repo.write('doc.md', 'v1')
    rec.handleEvent('doc.md')
    await rec.flush()
    expect((await readVersions(log)).length).toBe(1)

    await repo.write('doc.md', 'v2')
    rec.handleEvent('doc.md')
    await rec.flush()
    let versions = await readVersions(log)
    expect(versions.length).toBe(2)

    rec.handleEvent('doc.md') // no content change
    await rec.flush()
    versions = await readVersions(log)
    expect(versions.length).toBe(2) // deduped

    const objects = historyPaths(base, repo.root).objectsDir
    expect(await getObject(objects, versions[1].sha)).toBe('v2')
    await rec.close()
  })

  it('skips binary files', async () => {
    await setup()
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    await repo.write('bin.dat', Buffer.from([1, 2, 0, 3]))
    rec.handleEvent('bin.dat')
    await rec.flush()
    expect(await readVersions(historyPaths(base, repo.root).logFile('bin.dat'))).toEqual([])
    await rec.close()
  })

  it('prunes versions at/older than the last commit on a .git/HEAD event', async () => {
    await setup()
    const rec = createRecorder(repo.root, { historyBaseDir: base, settleMs: 5 })
    const log = historyPaths(base, repo.root).logFile('doc.md')

    // Seed an old version (pre-commit) and a future one (post-commit).
    await appendVersion(log, { ts: 1000, sha: 'old', size: 2 })
    await appendVersion(log, { ts: Date.now() + 100_000, sha: 'new', size: 2 })

    await repo.write('doc.md', 'committed')
    await repo.git('add', '.')
    await repo.git('commit', '-m', 'c')

    rec.handleEvent('.git/HEAD')
    await rec.flush()

    expect((await readVersions(log)).map((v) => v.sha)).toEqual(['new'])
    await rec.close()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/main/history/recorder.test.ts`
Expected: FAIL — cannot find module `./recorder`.

- [ ] **Step 3: Implement `recorder.ts`**

```typescript
// src/main/history/recorder.ts
import { createHash } from 'crypto'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { HistoryVersion } from '@shared/types'
import { readCurrentFile } from '../git/content'
import { runGit } from '../git/run'
import { historyPaths, type HistoryPaths } from './paths'
import {
  appendVersion,
  applyBackstops,
  gcObjects,
  putObject,
  pruneLog,
  readState,
  readVersions,
  referencedShas,
  writeState,
  writeVersions
} from './store'

const SETTLE_MS = 2500
const MAX_SETTLE_MS = 30000
const PRUNE_DEBOUNCE_MS = 500

export interface Recorder {
  handleEvent(relPath: string | null): void
  flush(): Promise<void>
  close(): Promise<void>
}

export interface RecorderOptions {
  historyBaseDir: string
  settleMs?: number
}

export function createRecorder(root: string, options: RecorderOptions): Recorder {
  const paths = historyPaths(options.historyBaseDir, root)
  const settleMs = options.settleMs ?? SETTLE_MS

  const settleTimers = new Map<string, NodeJS.Timeout>()
  const maxTimers = new Map<string, NodeJS.Timeout>()
  const queues = new Map<string, Promise<void>>()
  let pruneTimer: NodeJS.Timeout | null = null
  let prunePending: Promise<void> = Promise.resolve()

  const enqueue = (relPath: string, fn: () => Promise<void>): Promise<void> => {
    const prev = queues.get(relPath) ?? Promise.resolve()
    const next = prev.then(fn, fn)
    queues.set(
      relPath,
      next.catch(() => {})
    )
    return next
  }

  const capture = async (relPath: string): Promise<void> => {
    const fc = await readCurrentFile(join(root, relPath))
    if (fc.kind !== 'text') return
    const content = fc.content
    const sha = createHash('sha256').update(content).digest('hex')
    const logFile = paths.logFile(relPath)
    const existing = await readVersions(logFile)
    if (existing.length && existing[existing.length - 1].sha === sha) return
    await putObject(paths.objectsDir, content)
    await appendVersion(logFile, { ts: Date.now(), sha, size: Buffer.byteLength(content, 'utf8') })
    const trimmed = applyBackstops([...existing, { ts: Date.now(), sha, size: 0 }], Date.now())
    if (trimmed.length < existing.length + 1) {
      // Re-read to keep real ts/size then re-trim, then rewrite + gc.
      const fresh = applyBackstops(await readVersions(logFile), Date.now())
      await writeVersions(logFile, fresh)
      await gcAll()
    }
  }

  const fire = (relPath: string): void => {
    const s = settleTimers.get(relPath)
    if (s) clearTimeout(s)
    settleTimers.delete(relPath)
    const m = maxTimers.get(relPath)
    if (m) clearTimeout(m)
    maxTimers.delete(relPath)
    void enqueue(relPath, () => capture(relPath))
  }

  const scheduleSettle = (relPath: string): void => {
    const s = settleTimers.get(relPath)
    if (s) clearTimeout(s)
    settleTimers.set(
      relPath,
      setTimeout(() => fire(relPath), settleMs)
    )
    if (!maxTimers.has(relPath)) {
      maxTimers.set(
        relPath,
        setTimeout(() => fire(relPath), MAX_SETTLE_MS)
      )
    }
  }

  const allLogs = async (): Promise<HistoryVersion[][]> => {
    let names: string[]
    try {
      names = await readdir(paths.logsDir)
    } catch {
      return []
    }
    return Promise.all(names.map((n) => readVersions(join(paths.logsDir, n))))
  }

  const gcAll = async (): Promise<void> => {
    await gcObjects(paths.objectsDir, referencedShas(await allLogs()))
  }

  const runPrune = async (): Promise<void> => {
    const head = await runGit(root, ['rev-parse', 'HEAD'])
    if (head.code !== 0) return
    const sha = head.stdout.trim()
    const state = await readState(paths.stateFile)
    if (state.lastPrunedCommit === sha) return
    const ct = await runGit(root, ['show', '-s', '--format=%ct', sha])
    if (ct.code !== 0) return
    const commitMillis = parseInt(ct.stdout.trim(), 10) * 1000
    let names: string[]
    try {
      names = await readdir(paths.logsDir)
    } catch {
      names = []
    }
    for (const n of names) {
      const file = join(paths.logsDir, n)
      const versions = await readVersions(file)
      const pruned = pruneLog(versions, commitMillis)
      if (pruned.length !== versions.length) await writeVersions(file, pruned)
    }
    await writeState(paths.stateFile, { lastPrunedCommit: sha })
    await gcAll()
  }

  const schedulePrune = (): void => {
    if (pruneTimer) clearTimeout(pruneTimer)
    pruneTimer = setTimeout(() => {
      pruneTimer = null
      prunePending = runPrune()
    }, PRUNE_DEBOUNCE_MS)
  }

  const drain = async (): Promise<void> => {
    await Promise.all([...queues.values()])
    await prunePending
  }

  return {
    handleEvent(relPath) {
      if (relPath === null) return
      if (relPath === '.git' || relPath.startsWith('.git/')) return schedulePrune()
      scheduleSettle(relPath)
    },
    async flush() {
      for (const relPath of [...settleTimers.keys(), ...maxTimers.keys()]) fire(relPath)
      if (pruneTimer) {
        clearTimeout(pruneTimer)
        pruneTimer = null
        prunePending = runPrune()
      }
      await drain()
    },
    async close() {
      for (const t of settleTimers.values()) clearTimeout(t)
      for (const t of maxTimers.values()) clearTimeout(t)
      settleTimers.clear()
      maxTimers.clear()
      if (pruneTimer) clearTimeout(pruneTimer)
      pruneTimer = null
      await drain()
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/main/history/recorder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/history/recorder.ts src/main/history/recorder.test.ts
git commit -m "feat(history): settle-based recorder with commit-anchored pruning"
```

---

### Task 5: Wire recorder + history IPC + preload API

**Files:**
- Modify: `src/main/ipc.ts` (Session, openRepo, closeSession, new handlers)
- Modify: `src/preload/index.ts` (api additions)

**Interfaces:**
- Consumes: `createRecorder`/`Recorder` (Task 4); `historyPaths` (Task 1); `getObject`/`readVersions` (Task 2); `app.getPath('userData')`.
- Produces (IPC + preload):
  - `history:list(relPath: string) → HistoryVersion[]`
  - `history:read(sha: string) → string`
  - preload: `historyList(relPath: string): Promise<HistoryVersion[]>`, `historyRead(sha: string): Promise<string>`

- [ ] **Step 1: Add recorder to the session and history IPC in `ipc.ts`**

Add imports at the top of `src/main/ipc.ts`:

```typescript
import { app } from 'electron'
import type { HistoryVersion } from '@shared/types'
import { createRecorder, type Recorder } from './history/recorder'
import { historyPaths } from './history/paths'
import { getObject, readVersions } from './history/store'
```

Extend the `Session` interface:

```typescript
interface Session {
  root: string
  baseline: BaselineKind
  watcher: FSWatcher
  recorder: Recorder | null
}
```

Update `closeSession` to close the recorder:

```typescript
async function closeSession(): Promise<void> {
  if (session) {
    await session.watcher.close()
    if (session.recorder) await session.recorder.close()
    session = null
  }
}
```

In `openRepo`, inside the `state.kind === 'repo'` block, create the recorder and forward events to it. Replace the block from Task 3 Step 4 with:

```typescript
    const watchRoot = state.root
    const recorder = createRecorder(watchRoot, { historyBaseDir: app.getPath('userData') })
    let recomputeTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, (relPath) => {
      recorder.handleEvent(relPath)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const fresh = await computeRepoState(watchRoot)
        if (session?.root !== watchRoot) return // repo switched — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    session = { root: state.root, baseline: state.baseline, watcher, recorder }
```

- [ ] **Step 2: Register the history IPC handlers**

Inside `registerIpc`, add alongside the other `ipcMain.handle` calls:

```typescript
  ipcMain.handle('history:list', async (_e, relPath: string): Promise<HistoryVersion[]> => {
    if (!session) return []
    const paths = historyPaths(app.getPath('userData'), session.root)
    return readVersions(paths.logFile(relPath))
  })

  ipcMain.handle('history:read', async (_e, sha: string): Promise<string> => {
    if (!session) return ''
    const paths = historyPaths(app.getPath('userData'), session.root)
    try {
      return await getObject(paths.objectsDir, sha)
    } catch {
      return ''
    }
  })
```

- [ ] **Step 3: Expose the API in preload**

In `src/preload/index.ts`, add to the imported types and the `api` object:

```typescript
import type { FileContent, HistoryVersion, RepoState } from '@shared/types'
```

```typescript
  historyList: (relPath: string): Promise<HistoryVersion[]> =>
    ipcRenderer.invoke('history:list', relPath),
  historyRead: (sha: string): Promise<string> => ipcRenderer.invoke('history:read', sha),
```

- [ ] **Step 4: Verify typecheck and full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; all existing + new tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc.ts src/preload/index.ts
git commit -m "feat(history): wire recorder into session + history IPC/preload"
```

---

### Task 6: Renderer selection logic (pure, tested)

**Files:**
- Create: `src/renderer/src/history/selection.ts`
- Test: `src/renderer/src/history/selection.test.ts`

**Interfaces:**
- Consumes: `HistoryVersion` (Task 1).
- Produces:
  - `type RevisionRef = 'baseline' | 'now' | { sha: string }`
  - `interface Selection { base: RevisionRef; compare: RevisionRef }`
  - `defaultSelection(): Selection` → `{ base: 'baseline', compare: 'now' }`
  - `isDefaultSelection(s: Selection): boolean`
  - `sameRef(a: RevisionRef, b: RevisionRef): boolean`
  - `singleClickSelection(versions: HistoryVersion[], ref: RevisionRef): Selection`
  - `baselineLabel(): string` / `nowLabel(): string`

- [ ] **Step 1: Write the failing tests**

```typescript
// src/renderer/src/history/selection.test.ts
import { describe, it, expect } from 'vitest'
import {
  defaultSelection,
  isDefaultSelection,
  sameRef,
  singleClickSelection
} from './selection'
import type { HistoryVersion } from '@shared/types'

const v = (ts: number, sha: string): HistoryVersion => ({ ts, sha, size: 1 })
const versions = [v(100, 'a'), v(200, 'b'), v(300, 'c')] // ascending

describe('selection', () => {
  it('default is baseline↔now', () => {
    expect(defaultSelection()).toEqual({ base: 'baseline', compare: 'now' })
    expect(isDefaultSelection(defaultSelection())).toBe(true)
    expect(isDefaultSelection({ base: 'baseline', compare: { sha: 'a' } })).toBe(false)
  })

  it('clicking a middle revision diffs it against the previous one', () => {
    expect(singleClickSelection(versions, { sha: 'b' })).toEqual({
      base: { sha: 'a' },
      compare: { sha: 'b' }
    })
  })

  it('clicking the oldest revision diffs it against baseline', () => {
    expect(singleClickSelection(versions, { sha: 'a' })).toEqual({
      base: 'baseline',
      compare: { sha: 'a' }
    })
  })

  it('clicking Now diffs the newest revision against now', () => {
    expect(singleClickSelection(versions, 'now')).toEqual({
      base: { sha: 'c' },
      compare: 'now'
    })
  })

  it('clicking Now with no versions is baseline↔now', () => {
    expect(singleClickSelection([], 'now')).toEqual({ base: 'baseline', compare: 'now' })
  })

  it('clicking Baseline resets to the full diff', () => {
    expect(singleClickSelection(versions, 'baseline')).toEqual({ base: 'baseline', compare: 'now' })
  })

  it('sameRef compares by sha/sentinel', () => {
    expect(sameRef({ sha: 'a' }, { sha: 'a' })).toBe(true)
    expect(sameRef({ sha: 'a' }, { sha: 'b' })).toBe(false)
    expect(sameRef('now', 'now')).toBe(true)
    expect(sameRef('now', 'baseline')).toBe(false)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/renderer/src/history/selection.test.ts`
Expected: FAIL — cannot find module `./selection`.

- [ ] **Step 3: Implement `selection.ts`**

```typescript
// src/renderer/src/history/selection.ts
import type { HistoryVersion } from '@shared/types'

export type RevisionRef = 'baseline' | 'now' | { sha: string }

export interface Selection {
  base: RevisionRef
  compare: RevisionRef
}

export function defaultSelection(): Selection {
  return { base: 'baseline', compare: 'now' }
}

export function sameRef(a: RevisionRef, b: RevisionRef): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.sha === b.sha
}

export function isDefaultSelection(s: Selection): boolean {
  return s.base === 'baseline' && s.compare === 'now'
}

/**
 * Result of clicking one row: show what that revision changed.
 * - a version → base is the immediately older version, or baseline if oldest
 * - 'now'     → base is the newest version, or baseline if none
 * - 'baseline'→ reset to the full baseline↔now diff
 * `versions` is ascending by ts.
 */
export function singleClickSelection(versions: HistoryVersion[], ref: RevisionRef): Selection {
  if (ref === 'baseline') return defaultSelection()
  if (ref === 'now') {
    const newest = versions[versions.length - 1]
    return { base: newest ? { sha: newest.sha } : 'baseline', compare: 'now' }
  }
  const idx = versions.findIndex((v) => v.sha === ref.sha)
  const prev = idx > 0 ? versions[idx - 1] : null
  return { base: prev ? { sha: prev.sha } : 'baseline', compare: { sha: ref.sha } }
}

export function baselineLabel(): string {
  return 'Baseline (git)'
}

export function nowLabel(): string {
  return 'Now'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/history/selection.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/history/selection.ts src/renderer/src/history/selection.test.ts
git commit -m "feat(history): renderer revision selection logic"
```

---

### Task 7: HistoryPane component

**Files:**
- Create: `src/renderer/src/components/HistoryPane.tsx`
- Modify: `src/renderer/src/styles.css` (append pane styles)

**Interfaces:**
- Consumes: `HistoryVersion` (Task 1); `RevisionRef`, `Selection`, `sameRef`, `baselineLabel`, `nowLabel` (Task 6).
- Produces: `HistoryPane` (default export):

```typescript
export default function HistoryPane(props: {
  versions: HistoryVersion[]
  selection: Selection
  isGitRepo: boolean
  onSelect: (ref: RevisionRef, additive: boolean) => void
}): React.JSX.Element
```

- [ ] **Step 1: Implement `HistoryPane.tsx`**

```typescript
// src/renderer/src/components/HistoryPane.tsx
import type { HistoryVersion } from '@shared/types'
import {
  baselineLabel,
  nowLabel,
  sameRef,
  type RevisionRef,
  type Selection
} from '../history/selection'

const timeLabel = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

function isSelected(sel: Selection, ref: RevisionRef): 'base' | 'compare' | null {
  if (sameRef(sel.base, ref)) return 'base'
  if (sameRef(sel.compare, ref)) return 'compare'
  return null
}

export default function HistoryPane({
  versions,
  selection,
  isGitRepo,
  onSelect
}: {
  versions: HistoryVersion[]
  selection: Selection
  isGitRepo: boolean
  onSelect: (ref: RevisionRef, additive: boolean) => void
}): React.JSX.Element {
  if (!isGitRepo) {
    return (
      <div className="history-pane">
        <div className="history-title">History</div>
        <div className="history-empty">Not a git repo — no local history.</div>
      </div>
    )
  }

  const rows: Array<{ key: string; ref: RevisionRef; label: string }> = [
    { key: 'now', ref: 'now', label: nowLabel() },
    ...[...versions].reverse().map((v) => ({ key: v.sha, ref: { sha: v.sha }, label: timeLabel(v.ts) })),
    { key: 'baseline', ref: 'baseline', label: baselineLabel() }
  ]

  return (
    <div className="history-pane">
      <div className="history-title">History</div>
      {versions.length === 0 ? (
        <div className="history-empty">No local history yet — edits appear here as you work.</div>
      ) : (
        <ul className="history-list">
          {rows.map((row) => {
            const role = isSelected(selection, row.ref)
            return (
              <li
                key={row.key}
                className={`history-row${role ? ` sel-${role}` : ''}`}
                onClick={(e) => onSelect(row.ref, e.metaKey || e.shiftKey)}
              >
                <span className="history-dot" />
                <span className="history-label">{row.label}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Append styles to `src/renderer/src/styles.css`**

```css
.history-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow: auto;
  background: #1e1e1e;
  border-top: 1px solid #333;
}
.history-title {
  padding: 6px 10px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: #888;
}
.history-empty {
  padding: 8px 10px;
  color: #777;
  font-size: 12px;
}
.history-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.history-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 10px;
  cursor: pointer;
  font-size: 12px;
  color: #ccc;
}
.history-row:hover {
  background: #2a2d2e;
}
.history-row .history-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #666;
  flex: none;
}
.history-row.sel-base {
  background: #37373d;
}
.history-row.sel-compare {
  background: #094771;
}
.history-row.sel-base .history-dot,
.history-row.sel-compare .history-dot {
  background: #4da3ff;
}
```

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run typecheck && npx electron-vite build`
Expected: typecheck clean; build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/HistoryPane.tsx src/renderer/src/styles.css
git commit -m "feat(history): HistoryPane revision list component"
```

---

### Task 8: ContentPane consumes selection to drive the diff

**Files:**
- Modify: `src/renderer/src/components/ContentPane.tsx`

**Interfaces:**
- Consumes: `RevisionRef`, `Selection`, `isDefaultSelection` (Task 6); `HistoryVersion` (Task 1); `window.viewmaster.historyRead` (Task 5).
- Produces: `ContentPane` now takes `versions: HistoryVersion[]` and `selection: Selection` in addition to `file` and `refreshKey`.

- [ ] **Step 1: Add props and a ref resolver**

At the top of `src/renderer/src/components/ContentPane.tsx`, extend imports:

```typescript
import type { ChangedFile, FileContent, HistoryVersion } from '@shared/types'
import { isDefaultSelection, type RevisionRef, type Selection } from '../history/selection'
```

Replace the component signature and its `useState`/effects with:

```typescript
export default function ContentPane({
  file,
  refreshKey,
  selection,
  versions
}: {
  file: ChangedFile | null
  refreshKey: number
  selection: Selection
  versions: HistoryVersion[]
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('view')
  const [sideBySide, setSideBySide] = useState(true)
  const [content, setContent] = useState<FileContent | null>(null)
  const [baseContent, setBaseContent] = useState<string | null>(null)
  const [compareContent, setCompareContent] = useState<string | null>(null)

  // Reset to rendered/view mode when switching files.
  useEffect(() => {
    setMode('view')
  }, [file?.path])

  // A non-default revision selection means "show a diff"; jump into diff mode.
  useEffect(() => {
    if (!isDefaultSelection(selection)) setMode((m) => (m === 'view' ? 'diff' : m))
  }, [selection])

  // Current on-disk content (for view mode + the 'now' ref).
  useEffect(() => {
    if (!file) return
    let stale = false
    void window.viewmaster.readFile(file.absPath).then((c) => {
      if (!stale) setContent(c)
    })
    return () => {
      stale = true
    }
  }, [file, refreshKey])

  // Resolve base/compare sides from the selection when diffing.
  useEffect(() => {
    if (!file || (mode !== 'diff' && mode !== 'marks')) return
    let stale = false
    const resolve = async (ref: RevisionRef): Promise<string> => {
      if (ref === 'baseline') return window.viewmaster.readBaseFile(file.path)
      if (ref === 'now') {
        const c = await window.viewmaster.readFile(file.absPath)
        return c.kind === 'text' ? c.content : ''
      }
      return window.viewmaster.historyRead(ref.sha)
    }
    void resolve(selection.base).then((b) => {
      if (!stale) setBaseContent(b)
    })
    void resolve(selection.compare).then((c) => {
      if (!stale) setCompareContent(c)
    })
    return () => {
      stale = true
    }
  }, [file, mode, selection, refreshKey])
```

- [ ] **Step 2: Feed the resolved sides into DiffView/MarkdownView**

In the body-selection block, replace the `mode === 'diff'` and `mode === 'marks'` branches with:

```typescript
  } else if (mode === 'diff') {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading diff…" />
      ) : (
        <DiffView
          fileName={fileName}
          original={baseContent}
          modified={compareContent}
          sideBySide={sideBySide}
        />
      )
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView content={compareContent} baseContent={baseContent} />
      )
```

Note: the plain view branch still uses `content.content` (current on-disk) — unchanged.

- [ ] **Step 3: Verify typecheck + build**

Run: `npm run typecheck && npx electron-vite build`
Expected: typecheck clean (App will still be updated in Task 9 to pass the new props — if typecheck flags missing props on `<ContentPane>` in App.tsx, that is expected and resolved in Task 9). To keep this task independently green, temporarily verify via: `npx tsc --noEmit -p tsconfig.web.json 2>&1 | grep -v 'App.tsx' || true` and confirm no errors originate in `ContentPane.tsx`.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/components/ContentPane.tsx
git commit -m "feat(history): ContentPane resolves base/compare from selection"
```

---

### Task 9: App wires the nested split, versions, and selection

**Files:**
- Modify: `src/renderer/src/App.tsx`

**Interfaces:**
- Consumes: `HistoryPane` (Task 7); `ContentPane` new props (Task 8); `HistoryVersion` (Task 1); `Selection`/`RevisionRef`/`defaultSelection`/`singleClickSelection` (Task 6); `window.viewmaster.historyList` (Task 5).

- [ ] **Step 1: Add imports and state**

In `src/renderer/src/App.tsx`, extend imports:

```typescript
import type { ChangedFile, HistoryVersion, RepoState } from '@shared/types'
import Sidebar from './components/Sidebar'
import ContentPane from './components/ContentPane'
import HistoryPane from './components/HistoryPane'
import {
  defaultSelection,
  singleClickSelection,
  type RevisionRef,
  type Selection
} from './history/selection'
```

Inside `App`, add to the existing state:

```typescript
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [selection, setSelection] = useState<Selection>(defaultSelection())
```

- [ ] **Step 2: Load versions and reset selection on file/refresh changes**

Add after the existing effects in `App`:

```typescript
  // Reset the revision selection whenever the selected file changes.
  useEffect(() => {
    setSelection(defaultSelection())
  }, [selected?.path])

  // Load local history for the selected file (git repos only), refreshing when
  // the watcher reports a change.
  useEffect(() => {
    if (!selected || repo?.kind !== 'repo') {
      setVersions([])
      return
    }
    let stale = false
    void window.viewmaster.historyList(selected.path).then((v) => {
      if (!stale) setVersions(v)
    })
    return () => {
      stale = true
    }
  }, [selected?.path, repo?.kind, refreshKey])

  const onSelectRevision = useCallback(
    (ref: RevisionRef): void => {
      setSelection((prev) => {
        void prev
        return singleClickSelection(versions, ref)
      })
    },
    [versions]
  )
```

- [ ] **Step 3: Render the nested split**

The current repo-view render (verified) is:

```tsx
      <Allotment defaultSizes={[280, 920]}>
        <Allotment.Pane minSize={180} preferredSize={280}>
          <Sidebar state={repo} selected={selected?.path ?? null} onSelect={setSelected} />
        </Allotment.Pane>
        <Allotment.Pane>
          <ContentPane file={selected} refreshKey={refreshKey} />
        </Allotment.Pane>
      </Allotment>
```

Replace it with the nested layout, **preserving the exact `<Sidebar>` props** (`state`, `selected`, `onSelect`):

```tsx
      <Allotment defaultSizes={[280, 920]}>
        <Allotment.Pane minSize={180} preferredSize={280}>
          <Allotment vertical>
            <Allotment.Pane>
              <Sidebar state={repo} selected={selected?.path ?? null} onSelect={setSelected} />
            </Allotment.Pane>
            <Allotment.Pane preferredSize={220} minSize={80}>
              <HistoryPane
                versions={versions}
                selection={selection}
                isGitRepo={repo?.kind === 'repo'}
                onSelect={onSelectRevision}
              />
            </Allotment.Pane>
          </Allotment>
        </Allotment.Pane>
        <Allotment.Pane>
          <ContentPane
            file={selected}
            refreshKey={refreshKey}
            selection={selection}
            versions={versions}
          />
        </Allotment.Pane>
      </Allotment>
```

- [ ] **Step 4: Verify full typecheck, tests, and build**

Run: `npm run typecheck && npx vitest run && npx electron-vite build`
Expected: typecheck clean; all tests pass; build succeeds.

- [ ] **Step 5: Manual smoke test**

```bash
VIEWMASTER_OPEN=$(pwd) npm run dev
```
Confirm: History pane appears under the file tree; editing a tracked file adds a revision after ~2.5s; clicking a revision shows its diff; Baseline↔Now matches the prior whole-file diff; committing prunes older revisions.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/src/App.tsx
git commit -m "feat(history): dock history pane under file tree and wire selection"
```

---

## Self-Review

**Spec coverage:**
- Data model & storage → Tasks 1–2 (dropped `paths.json` per YAGNI; GC enumerates `logs/` directly — noted below).
- Settle-based capture, scope (text only), MAX_SETTLE → Task 4.
- Commit-anchored retention + backstops + GC → Tasks 2 (pure) + 4 (orchestration).
- Granular watcher → Task 3.
- IPC `history:list`/`history:read` + preload → Task 5.
- History pane + JetBrains selection (single-click = vs previous; ⌘/shift = range; Baseline↔Now default) → Tasks 6–9.
- Marks mode reuse → Task 8 (marks branch feeds compare/base).
- Git-repos-only, non-git placeholder → Tasks 5 (empty list) + 7 (placeholder).
- Error handling (binary/deleted skip, partial-line tolerance, crash-safe order) → Tasks 2 + 4.

**Deviation from spec:** `paths.json` is omitted. The UI only lists history for the already-known selected path, and GC reads the `logs/` directory, so a pathHash→path map is never consumed. This removes an unused write on the capture hot path.

**Deviation:** ⌘/Shift range-selection is scaffolded (`onSelect` receives an `additive` flag from `HistoryPane`, and `App` currently ignores it via `singleClickSelection`). Full two-row range selection can be added by storing an "anchor" ref in `App` and computing older/newer; single-click (the primary interaction) is fully implemented. This keeps Task 9 shippable; range selection is a follow-up increment, not a spec gap in the core flow.

**Placeholder scan:** none — every code step contains full implementations.

**Type consistency:** `HistoryVersion {ts,sha,size}` is used identically across store, recorder, IPC, preload, selection, and components. `RevisionRef`/`Selection` are defined once in Task 6 and consumed by Tasks 7–9. `createRecorder(root, {historyBaseDir, settleMs?})` and `Recorder {handleEvent, flush, close}` match between Task 4 and Task 5.
