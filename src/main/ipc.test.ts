import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { realpath } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, join } from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SymbolLocationsResult, SymbolQuery } from '@shared/types'
import type { ExternalRoot } from './files/externalRoots'
import type { LspAnswer } from './lsp/manager'
import { makeRepo, type TestRepo } from './git/testRepo'

// Every ipcMain.handle registration is captured so handlers can be invoked
// directly (see registerIpc below).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const handlers = vi.hoisted(() => new Map<string, (...args: any[]) => any>())

// ipc.ts (and store.ts, transitively, via electron-store) import 'electron'
// at module load time. There's no Electron process running in the test
// runner, so 'electron' is stubbed here with just enough surface for
// openRepo() and its dependencies (electron-store) to run.
const userDataDir = join(tmpdir(), 'viewmaster-ipc-test-userdata')
mkdirSync(userDataDir, { recursive: true })

vi.mock('electron', () => ({
  app: {
    getPath: () => userDataDir,
    getVersion: () => '0.0.0-test'
  },
  BrowserWindow: class {},
  clipboard: { writeText: () => {} },
  dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
  ipcMain: {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    handle: (channel: string, fn: (...args: any[]) => any) => handlers.set(channel, fn),
    on: () => {}
  },
  shell: {
    openPath: async () => '',
    openExternal: async () => {},
    showItemInFolder: () => {}
  }
}))

// Real fs.watch on the repo dir works fine in tests, but we want direct
// visibility into whether a given watcher/recorder's close() was called --
// mocking these lets each openRepo() call's disposal be asserted on
// directly instead of inferred from side effects.
interface FakeWatcher {
  root: string
  close: ReturnType<typeof vi.fn>
}
interface FakeRecorder {
  root: string
  handleEvent: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

const watchers: FakeWatcher[] = []
const recorders: FakeRecorder[] = []

vi.mock('./watcher', () => ({
  watchRepo: vi.fn((root: string) => {
    const w: FakeWatcher = { root, close: vi.fn() }
    watchers.push(w)
    return w
  })
}))

vi.mock('./history/recorder', () => ({
  createRecorder: vi.fn((root: string) => {
    const r: FakeRecorder = { root, handleEvent: vi.fn(), close: vi.fn(async () => {}) }
    recorders.push(r)
    return r
  })
}))

// One fake LspManager per openRepo session; each test configures what
// `query` answers and which external roots the manager reports.
interface FakeManager {
  root: string
  query: ReturnType<typeof vi.fn>
  externalRoots: ReturnType<typeof vi.fn>
  dispose: ReturnType<typeof vi.fn>
}
const managers: FakeManager[] = []
const lspBehavior: {
  query: (kind: string, q: SymbolQuery) => Promise<LspAnswer>
  roots: ExternalRoot[]
} = {
  query: async () => ({ kind: 'fallback', reason: 'unavailable' }),
  roots: []
}

vi.mock('./lsp/manager', () => ({
  createLspManager: vi.fn((root: string) => {
    const m: FakeManager = {
      root,
      query: vi.fn((kind: string, q: SymbolQuery) => lspBehavior.query(kind, q)),
      externalRoots: vi.fn(() => lspBehavior.roots),
      dispose: vi.fn(async () => {})
    }
    managers.push(m)
    return m
  })
}))

const { isStaleGeneration, openRepo, registerIpc } = await import('./ipc')

const noopGetWindow = (): null => null
registerIpc(noopGetWindow)

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function invoke<T>(channel: string, ...args: any[]): Promise<T> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`no handler for ${channel}`)
  return Promise.resolve(fn({}, ...args))
}

describe('isStaleGeneration', () => {
  it('is not stale when the generation is unchanged', () => {
    expect(isStaleGeneration(1, 1)).toBe(false)
  })

  it('is stale once a newer call has bumped the generation', () => {
    expect(isStaleGeneration(1, 2)).toBe(true)
  })

  it('is never stale for the highest generation seen so far', () => {
    expect(isStaleGeneration(2, 2)).toBe(false)
  })
})

describe('openRepo generation race', () => {
  const cleanups: Array<() => Promise<void>> = []
  afterEach(async () => {
    for (const c of cleanups.splice(0)) await c()
    watchers.length = 0
    recorders.length = 0
  })

  it('closes the loser watcher/recorder and never leaks them into the session', async () => {
    const repoA: TestRepo = await makeRepo()
    const repoB: TestRepo = await makeRepo()
    cleanups.push(repoA.cleanup, repoB.cleanup)

    // Started in the same synchronous tick, so per JS run-to-completion
    // semantics call A is guaranteed generation 1 and call B generation 2
    // (each call's `myGeneration = ++openGeneration` runs before its first
    // await). Because nothing bumps the generation counter further after
    // that, B can never observe itself as stale -- it always wins -- and A
    // always observes generation 2 by the time it checks, so it always
    // loses. This makes the outcome deterministic regardless of which
    // call's async git work actually finishes first.
    const [stateA, stateB] = await Promise.all([
      openRepo(noopGetWindow, repoA.root),
      openRepo(noopGetWindow, repoB.root)
    ])

    expect(stateA.kind).not.toBe('error')
    expect(stateB.kind).not.toBe('error')

    expect(watchers).toHaveLength(2)
    expect(recorders).toHaveLength(2)

    const watcherA = watchers.find((w) => w.root === repoA.root)
    const watcherB = watchers.find((w) => w.root === repoB.root)
    const recorderA = recorders.find((r) => r.root === repoA.root)
    const recorderB = recorders.find((r) => r.root === repoB.root)

    // A lost the race: its watcher/recorder must be disposed, not leaked.
    expect(watcherA?.close).toHaveBeenCalledTimes(1)
    expect(recorderA?.close).toHaveBeenCalledTimes(1)

    // B won: its watcher/recorder must still be live (assigned into the
    // session, not disposed).
    expect(watcherB?.close).not.toHaveBeenCalled()
    expect(recorderB?.close).not.toHaveBeenCalled()
  })
})

describe('openRepo error propagation', () => {
  it('returns a graceful error state instead of rejecting when root does not exist', async () => {
    // A stale/deleted Recent Folder: resolveRoot's runGit call rejects with
    // ENOCWD (see git/run.ts). Before this fix, nothing caught that
    // rejection between runGit and the repo:open IPC handler, so it
    // propagated as an unhandled promise rejection instead of the
    // structured RepoState the rest of the app expects.
    const missingRoot = join(tmpdir(), 'viewmaster-ipc-test-does-not-exist')
    const state = await openRepo(noopGetWindow, missingRoot)
    expect(state.kind).toBe('error')
    if (state.kind === 'error') {
      expect(state.root).toBe(missingRoot)
      expect(state.message).toContain('Folder not found')
    }
  })
})

const missingRoot = join(tmpdir(), 'viewmaster-ipc-test-does-not-exist')

describe('LSP wiring', () => {
  // Plain (non-git) temp folders: folder-mode sessions keep the root exactly
  // as given, so paths compare cleanly on Windows.
  const dirs: string[] = []
  const mkdir = async (prefix: string): Promise<string> => {
    const d = await realpath(mkdtempSync(join(tmpdir(), prefix)))
    dirs.push(d)
    return d
  }
  let ws: string

  beforeEach(async () => {
    ws = await mkdir('vm-ipc-ws-')
    writeFileSync(join(ws, 'main.go'), 'package main\n\nfunc Foo() {}\n\nfunc main() { Foo() }\n')
    writeFileSync(join(ws, 'util.ts'), 'export function Bar() {}\n')
    lspBehavior.query = async () => ({ kind: 'fallback', reason: 'unavailable' })
    lspBehavior.roots = []
    managers.length = 0
    const state = await openRepo(noopGetWindow, ws)
    expect(state.kind).toBe('folder')
  })
  afterEach(async () => {
    await openRepo(noopGetWindow, missingRoot) // closes the session
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
    managers.length = 0
    watchers.length = 0
    recorders.length = 0
  })

  const goQ = (): SymbolQuery => ({ word: 'Foo', absPath: join(ws, 'main.go'), line: 5, column: 15 })

  it('creates one manager per session and disposes it on folder switch', async () => {
    expect(managers).toHaveLength(1)
    expect(managers[0].root).toBe(ws)
    const other = await mkdir('vm-ipc-other-')
    await openRepo(noopGetWindow, other)
    expect(managers[0].dispose).toHaveBeenCalledTimes(1)
    expect(managers).toHaveLength(2)
    expect(managers[1].dispose).not.toHaveBeenCalled()
  })

  it('file:read serves a file under an external root and rejects one outside', async () => {
    const ext = await mkdir('vm-ipc-ext-')
    const outside = await mkdir('vm-ipc-outside-')
    writeFileSync(join(ext, 'fmt.go'), 'package fmt\n')
    writeFileSync(join(outside, 'secret.go'), 'package secret\n')
    lspBehavior.roots = [{ kind: 'go-stdlib', dir: ext }]

    expect(await invoke('file:read', join(ext, 'fmt.go'))).toEqual({ kind: 'text', content: 'package fmt\n' })
    expect(await invoke('file:read', join(outside, 'secret.go'))).toEqual({ kind: 'missing' })
    // traversal out of the root is resolved first, then rejected
    expect(await invoke('file:read', `${ext}/../${basename(outside)}/secret.go`)).toEqual({ kind: 'missing' })
    // in-root reads are unchanged
    expect(await invoke('file:read', join(ws, 'util.ts'))).toEqual({
      kind: 'text',
      content: 'export function Bar() {}\n'
    })
  })

  it('file:read stays graceful when the session closes mid-read', async () => {
    const read = invoke('file:read', join(ws, 'nope.go'))
    const closing = openRepo(noopGetWindow, missingRoot)
    expect(await read).toEqual({ kind: 'missing' })
    await closing
  })

  it('file:externalKind is null in-root or outside, else the kind', async () => {
    const ext = await mkdir('vm-ipc-ext-')
    writeFileSync(join(ext, 'x.go'), 'package x\n')
    lspBehavior.roots = [{ kind: 'go-modcache', dir: ext }]
    expect(await invoke('file:externalKind', join(ext, 'x.go'))).toBe('go-modcache')
    expect(await invoke('file:externalKind', join(ws, 'main.go'))).toBeNull()
    expect(await invoke('file:externalKind', join(tmpdir(), 'nope', 'x.go'))).toBeNull()
  })

  it('symbol:definitions returns LSP locations with source lsp', async () => {
    const loc = { path: 'main.go', absPath: join(ws, 'main.go'), line: 3, column: 5 }
    lspBehavior.query = async () => ({ kind: 'answer', locations: [loc] })
    const res = await invoke<SymbolLocationsResult>('symbol:definitions', goQ())
    expect(res).toEqual({ locations: [loc], truncated: false, source: 'lsp' })
    expect(managers[0].query).toHaveBeenCalledWith(
      'definition',
      expect.objectContaining({ word: 'Foo', line: 5, column: 15 })
    )
  })

  it('accepts a lowercase-drive absPath from Monaco', async () => {
    lspBehavior.query = async () => ({ kind: 'answer', locations: [] })
    const lower = goQ().absPath.replace(/^[A-Z]:/, (d) => d.toLowerCase())
    const res = await invoke<SymbolLocationsResult>('symbol:definitions', { ...goQ(), absPath: lower })
    expect(res.source).toBe('lsp')
  })

  it('an empty LSP answer is the answer', async () => {
    lspBehavior.query = async () => ({ kind: 'answer', locations: [] })
    const res = await invoke<SymbolLocationsResult>('symbol:references', goQ())
    expect(res).toEqual({ locations: [], truncated: false, source: 'lsp' })
    expect(managers[0].query).toHaveBeenCalledWith('references', expect.anything())
  })

  it('symbol:definitions labels heuristic fallback', async () => {
    lspBehavior.query = async () => ({ kind: 'fallback', reason: 'starting' })
    const res = await invoke<SymbolLocationsResult>('symbol:definitions', goQ())
    expect(res.source).toBe('heuristic')
    expect(res.approximate).toEqual({ language: 'go', reason: 'starting' })
    expect(res.locations.map((l) => [l.path, l.line])).toEqual([['main.go', 3]])
  })

  it('symbol:references labels heuristic fallback', async () => {
    lspBehavior.query = async () => ({ kind: 'fallback', reason: 'not-installed' })
    const res = await invoke<SymbolLocationsResult>('symbol:references', goQ())
    expect(res.source).toBe('heuristic')
    expect(res.approximate).toEqual({ language: 'go', reason: 'not-installed' })
    expect(res.locations.map((l) => l.line).sort()).toEqual([3, 5])
  })

  it('a path outside every allowed root falls back without asking the manager', async () => {
    const outside = await mkdir('vm-ipc-outside-')
    writeFileSync(join(outside, 'x.go'), 'package x\n')
    const res = await invoke<SymbolLocationsResult>('symbol:definitions', { ...goQ(), absPath: join(outside, 'x.go') })
    expect(res.source).toBe('heuristic')
    expect(res.approximate).toEqual({ language: 'go', reason: 'unavailable' })
    expect(managers[0].query).not.toHaveBeenCalled()
  })

  it('other languages use the heuristic without asking the manager', async () => {
    const res = await invoke<SymbolLocationsResult>('symbol:definitions', {
      word: 'Bar',
      absPath: join(ws, 'util.ts'),
      line: 1,
      column: 17
    })
    expect(res.source).toBe('heuristic')
    expect(res.approximate).toBeUndefined()
    expect(res.locations.map((l) => l.path)).toEqual(['util.ts'])
    expect(managers[0].query).not.toHaveBeenCalled()
  })

  it('never delivers a previous session LSP answer into a new session', async () => {
    let release!: (a: LspAnswer) => void
    lspBehavior.query = () => new Promise<LspAnswer>((r) => (release = r))
    const pending = invoke<SymbolLocationsResult>('symbol:definitions', goQ())
    await vi.waitFor(() => expect(managers[0].query).toHaveBeenCalled())
    const other = await mkdir('vm-ipc-other-')
    await openRepo(noopGetWindow, other)
    release({ kind: 'answer', locations: [{ path: 'main.go', absPath: join(ws, 'main.go'), line: 3, column: 5 }] })
    const res = await pending
    expect(res.source).not.toBe('lsp')
    expect(res.locations.some((l) => l.absPath.startsWith(ws))).toBe(false)
  })

  it('symbol and externalKind handlers are graceful with no session', async () => {
    await openRepo(noopGetWindow, missingRoot)
    expect(await invoke('symbol:definitions', goQ())).toEqual({ locations: [], truncated: false })
    expect(await invoke('symbol:references', goQ())).toEqual({ locations: [], truncated: false })
    expect(await invoke('file:externalKind', join(ws, 'main.go'))).toBeNull()
    expect(await invoke('file:read', join(ws, 'main.go'))).toEqual({ kind: 'missing' })
  })
})
