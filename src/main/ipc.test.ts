import { mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeRepo, type TestRepo } from './git/testRepo'

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
  ipcMain: { handle: () => {}, on: () => {} },
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

const { isStaleGeneration, openRepo } = await import('./ipc')

const noopGetWindow = (): null => null

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
