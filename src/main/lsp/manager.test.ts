import { afterEach, describe, expect, it, vi } from 'vitest'
import { join } from 'path'
import type { SymbolLocation, SymbolQuery } from '../../shared/types'
import type { ExternalRoot } from '../files/externalRoots'
import { LspTimeoutError, type ClientState, type LspClient, type ServerCommand } from './client'
import {
  LspManager,
  MAX_RESTARTS,
  QUERY_TIMEOUT_MS,
  STARTING_GRACE_MS,
  type ManagerDeps
} from './manager'

const root = join('/', 'ws')
const goQ: SymbolQuery = { word: 'Foo', absPath: join(root, 'main.go'), line: 3, column: 5 }
const pyQ: SymbolQuery = { word: 'foo', absPath: join(root, 'app.py'), line: 1, column: 4 }
const loc: SymbolLocation = { path: 'main.go', absPath: join(root, 'main.go'), line: 9, column: 1 }
const goCmd: ServerCommand = { command: 'gopls', args: ['serve'], env: {} }

type Answer = SymbolLocation[] | Error | 'hang'

class FakeClient {
  startedAt = Date.now()
  st: ClientState = 'starting'
  startResult: 'ok' | Error | 'hang' = 'ok'
  next: Answer = []
  definition = vi.fn((..._a: unknown[]) => this.answer())
  references = vi.fn((..._a: unknown[]) => this.answer())
  dispose = vi.fn(async () => {
    this.st = 'dead'
  })
  onExit = vi.fn()
  notifyFilesChanged = vi.fn(async (_paths: string[]) => {})
  state(): ClientState {
    return this.st
  }
  start(): Promise<void> {
    if (this.startResult === 'hang') return new Promise(() => {})
    if (this.startResult instanceof Error) {
      this.st = 'dead'
      return Promise.reject(this.startResult)
    }
    this.st = 'ready'
    return Promise.resolve()
  }
  private answer(): Promise<SymbolLocation[]> {
    const a = this.next
    if (a === 'hang') return new Promise(() => {})
    if (a instanceof Error) return Promise.reject(a)
    return Promise.resolve(a)
  }
}

function setup(
  opts: {
    commandFor?: ManagerDeps['commandFor']
    configure?: (c: FakeClient, n: number) => void
    roots?: ExternalRoot[]
  } = {}
): { m: LspManager; clients: FakeClient[]; createClient: ReturnType<typeof vi.fn> } {
  const clients: FakeClient[] = []
  const createClient = vi.fn(() => {
    const c = new FakeClient()
    opts.configure?.(c, clients.length)
    clients.push(c)
    return c as unknown as LspClient
  })
  const m = new LspManager(root, {
    commandFor: opts.commandFor ?? (async () => goCmd),
    createClient,
    externalRootsFor: async () => opts.roots ?? []
  })
  managers.push(m)
  return { m, clients, createClient }
}

const managers: LspManager[] = []
afterEach(async () => {
  vi.useRealTimers()
  await Promise.all(managers.splice(0).map((m) => m.dispose()))
})

describe('LspManager', () => {
  it('starts lazily on first query', async () => {
    const { m, createClient } = setup({ configure: (c) => (c.next = [loc]) })
    expect(createClient).not.toHaveBeenCalled()
    expect(await m.query('definition', goQ)).toEqual({ kind: 'answer', locations: [loc] })
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('passes 1-based line and 0-based column through, with the remaining budget', async () => {
    const { m, clients } = setup()
    await m.query('references', goQ)
    const [abs, line, col, timeout] = clients[0].references.mock.calls[0]
    expect([abs, line, col]).toEqual([goQ.absPath, 3, 5])
    expect(timeout).toBeGreaterThan(0)
    expect(timeout).toBeLessThanOrEqual(QUERY_TIMEOUT_MS)
  })

  it('not-installed when commandFor returns null', async () => {
    const { m, createClient } = setup({ commandFor: async () => null })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'not-installed' })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'not-installed' })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('timeout soon after start is starting', async () => {
    const { m } = setup({ configure: (c) => (c.next = new LspTimeoutError()) })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'starting' })
  })

  it('timeout after grace is unavailable', async () => {
    const { m } = setup({
      configure: (c) => {
        c.startedAt = Date.now() - STARTING_GRACE_MS - 1
        c.next = new LspTimeoutError()
      }
    })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
  })

  it('a start that outlasts the query budget is starting, and the client is kept', async () => {
    vi.useFakeTimers()
    const { m, clients, createClient } = setup({ configure: (c) => (c.startResult = 'hang') })
    const p = m.query('definition', goQ)
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS + 1)
    expect(await p).toEqual({ kind: 'fallback', reason: 'starting' })
    expect(clients[0].dispose).not.toHaveBeenCalled()
    const p2 = m.query('definition', goQ)
    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT_MS + 1)
    expect(await p2).toEqual({ kind: 'fallback', reason: 'starting' })
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('empty answer is an answer', async () => {
    const { m } = setup({ configure: (c) => (c.next = []) })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'answer', locations: [] })
  })

  it('a server ResponseError soon after start (still loading) is starting', async () => {
    const err = Object.assign(new Error('no views'), { code: -32801 })
    const { m } = setup({ configure: (c) => (c.next = err) })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'starting' })
  })

  it('a server error is unavailable for that query but does not replace a live client', async () => {
    const { m, clients, createClient } = setup({ configure: (c) => (c.next = new Error('boom')) })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
    clients[0].next = [loc]
    expect(await m.query('definition', goQ)).toEqual({ kind: 'answer', locations: [loc] })
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('a createClient that throws is unavailable, with no unhandled rejection', async () => {
    const m = new LspManager(root, {
      commandFor: async () => goCmd,
      createClient: () => {
        throw new Error('spawn blew up')
      },
      externalRootsFor: async () => []
    })
    managers.push(m)
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
    await new Promise((r) => setTimeout(r, 20)) // let any stray rejection surface
  })

  it('a start failure is unavailable', async () => {
    const { m } = setup({ configure: (c) => (c.startResult = new Error('spawn ENOENT')) })
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
  })

  it('shares one client between concurrent first queries', async () => {
    const { m, createClient } = setup()
    await Promise.all([m.query('definition', goQ), m.query('references', goQ), m.query('definition', goQ)])
    expect(createClient).toHaveBeenCalledTimes(1)
  })

  it('keeps one client per language', async () => {
    const commandFor = vi.fn(async (_lang: string) => goCmd)
    const { m, createClient } = setup({ commandFor })
    await m.query('definition', goQ)
    await m.query('definition', pyQ)
    await m.query('definition', goQ)
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(commandFor.mock.calls.map((c) => c[0])).toEqual(['go', 'python'])
  })

  it('restarts a dead client', async () => {
    const { m, clients, createClient } = setup({ configure: (c) => (c.next = [loc]) })
    await m.query('definition', goQ)
    clients[0].st = 'dead'
    expect(await m.query('definition', goQ)).toEqual({ kind: 'answer', locations: [loc] })
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(clients[0].dispose).toHaveBeenCalled()
  })

  it('stops restarting after MAX_RESTARTS', async () => {
    const { m, createClient } = setup({ configure: (c) => (c.startResult = new Error('crash on start')) })
    for (let i = 0; i < 1 + MAX_RESTARTS; i++) {
      expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
    }
    for (let i = 0; i < 5; i++) {
      expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
    }
    expect(createClient).toHaveBeenCalledTimes(1 + MAX_RESTARTS)
  })

  it('dispose kills children and rejects pending queries', async () => {
    const { m, clients, createClient } = setup({ configure: (c) => (c.next = 'hang') })
    const pendingGo = m.query('definition', goQ)
    const pendingPy = m.query('references', pyQ)
    await vi.waitFor(() => expect(clients).toHaveLength(2))
    await m.dispose()
    expect(await pendingGo).toEqual({ kind: 'fallback', reason: 'unavailable' })
    expect(await pendingPy).toEqual({ kind: 'fallback', reason: 'unavailable' })
    for (const c of clients) expect(c.dispose).toHaveBeenCalled()
    expect(await m.query('definition', goQ)).toEqual({ kind: 'fallback', reason: 'unavailable' })
    expect(createClient).toHaveBeenCalledTimes(2)
  })

  it('does not spawn when disposed while resolving the command', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { m, createClient } = setup({
      commandFor: async () => {
        await gate
        return goCmd
      }
    })
    const p = m.query('definition', goQ)
    await m.dispose()
    release()
    expect(await p).toEqual({ kind: 'fallback', reason: 'unavailable' })
    await new Promise((r) => setTimeout(r, 10))
    expect(createClient).not.toHaveBeenCalled()
  })

  it('externalRoots is the union for languages started, available before the first answer', async () => {
    const goRoot: ExternalRoot = { kind: 'go-stdlib', dir: join('/', 'goroot') }
    const clients: FakeClient[] = []
    const m = new LspManager(root, {
      commandFor: async () => goCmd,
      createClient: () => {
        const c = new FakeClient()
        clients.push(c)
        return c as unknown as LspClient
      },
      externalRootsFor: async (lang) =>
        lang === 'go' ? [goRoot] : [{ kind: 'python-stubs', dir: join('/', 'stubs') }]
    })
    managers.push(m)
    expect(m.externalRoots()).toEqual([])
    await m.query('definition', goQ)
    expect(m.externalRoots()).toEqual([goRoot])
    await m.query('definition', pyQ)
    expect(m.externalRoots().map((r) => r.kind).sort()).toEqual(['go-stdlib', 'python-stubs'])
  })

  it('a non-LSP path is unavailable without spawning', async () => {
    const { m, createClient } = setup()
    expect(await m.query('definition', { ...goQ, absPath: join(root, 'a.ts') })).toEqual({
      kind: 'fallback',
      reason: 'unavailable'
    })
    expect(createClient).not.toHaveBeenCalled()
  })

  it('notifyFilesChanged forwards to running clients only, and never spawns', async () => {
    const { m, clients, createClient } = setup()
    const changed = [join(root, 'a.go'), join(root, 'go.mod')]
    m.notifyFilesChanged(changed) // nothing running yet
    expect(createClient).not.toHaveBeenCalled()

    await m.query('definition', goQ) // go is running
    m.notifyFilesChanged(changed)
    expect(clients[0].notifyFilesChanged).toHaveBeenCalledTimes(1)
    expect(clients[0].notifyFilesChanged).toHaveBeenCalledWith(changed)
    expect(createClient).toHaveBeenCalledTimes(1) // python was not started for it

    clients[0].st = 'dead'
    m.notifyFilesChanged(changed)
    expect(clients[0].notifyFilesChanged).toHaveBeenCalledTimes(1)
  })

  it('notifyFilesChanged swallows client errors and is a no-op once disposed', async () => {
    const { m, clients } = setup()
    await m.query('definition', goQ)
    clients[0].notifyFilesChanged.mockImplementation(() => {
      throw new Error('boom')
    })
    expect(() => m.notifyFilesChanged([join(root, 'a.go')])).not.toThrow()
    clients[0].notifyFilesChanged.mockImplementation(async () => {})
    await m.dispose()
    clients[0].st = 'ready'
    m.notifyFilesChanged([join(root, 'a.go')])
    expect(clients[0].notifyFilesChanged).toHaveBeenCalledTimes(1)
  })
})
