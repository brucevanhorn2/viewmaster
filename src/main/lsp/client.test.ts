import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, utimesSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join, resolve } from 'path'
import { pathToFileURL } from 'url'
import { LspClient, LspTimeoutError, START_TIMEOUT_MS, type ServerCommand } from './client'

const fakeServerPath = resolve(__dirname, 'fixtures', 'fakeServer.mjs')

function cmd(mode: string): ServerCommand {
  return { command: process.execPath, args: [fakeServerPath], env: { ...process.env, FAKE_MODE: mode } }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function waitDead(pid: number): Promise<boolean> {
  for (let i = 0; i < 50; i++) {
    if (!alive(pid)) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

describe('LspClient', () => {
  let root: string
  let file: string
  const clients: LspClient[] = []
  const make = (mode: string): LspClient => {
    const c = new LspClient(cmd(mode), root)
    clients.push(c)
    return c
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'lspclient-')))
    file = join(root, 'main.go')
    writeFileSync(file, 'package main\nfunc a() {}\n')
  })
  afterEach(async () => {
    await Promise.all(clients.splice(0).map((c) => c.dispose()))
    rmSync(root, { recursive: true, force: true })
  })

  it('start reaches ready', async () => {
    const c = make('ok')
    expect(c.state()).toBe('starting')
    await c.start()
    expect(c.state()).toBe('ready')
  })

  it('start rejects and state is dead when the command does not exist', async () => {
    const c = new LspClient({ command: join(root, 'no-such-binary'), args: [], env: process.env }, root)
    clients.push(c)
    await expect(c.start()).rejects.toThrow()
    expect(c.state()).toBe('dead')
  })

  it('definition translates the server answer', async () => {
    const c = make('ok')
    await c.start()
    const res = await c.definition(file, 1, 0, 5000)
    expect(res).toEqual([{ path: 'main.go', line: 5, column: 2, absPath: file }])
  })

  it('references translates the server answer', async () => {
    const c = make('ok')
    await c.start()
    const res = await c.references(file, 1, 0, 5000)
    expect(res).toEqual([{ path: 'main.go', line: 2, column: 0, absPath: file }])
  })

  it('empty answer resolves to []', async () => {
    const c = make('empty')
    await c.start()
    expect(await c.definition(file, 1, 0, 5000)).toEqual([])
  })

  it('timeout rejects with LspTimeoutError', async () => {
    const c = make('hang')
    await c.start()
    await expect(c.definition(file, 1, 0, 200)).rejects.toBeInstanceOf(LspTimeoutError)
  })

  it('crash fires onExit, state becomes dead, and the in-flight query rejects', async () => {
    const c = make('crash')
    await c.start()
    let exited = false
    const exitP = new Promise<void>((r) => c.onExit(() => { exited = true; r() }))
    const q = c.definition(file, 1, 0, 10000)
    const err = await q.then(() => null, (e) => e)
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(LspTimeoutError)
    await exitP
    expect(exited).toBe(true)
    expect(c.state()).toBe('dead')
  })

  it('reopens a document whose mtime changed', async () => {
    const c = make('ok')
    await c.start()
    await c.definition(file, 1, 0, 5000)
    writeFileSync(file, 'package main\nfunc b() {}\n')
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)
    await c.definition(file, 1, 0, 5000)

    const events = await queryOpened(c)
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose', 'didOpen', 'didClose'])
    expect(events[0].languageId).toBe('go')
    expect(events[0].text).toBe('package main\nfunc a() {}\n')
    expect(events[2].text).toBe('package main\nfunc b() {}\n')
    expect(events[2].version).toBeGreaterThan(events[0].version)
  })

  it('closes the document after each query, whether it succeeds or times out', async () => {
    const ok = make('ok')
    await ok.start()
    await ok.definition(file, 1, 0, 5000)
    await ok.references(file, 1, 0, 5000)
    const evOk = await queryOpened(ok)
    expect(evOk.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose', 'didOpen', 'didClose'])
    expect(evOk[1].uri).toBe(evOk[0].uri)

    const hang = make('hang')
    await hang.start()
    await expect(hang.definition(file, 1, 0, 200)).rejects.toBeInstanceOf(LspTimeoutError)
    const evHang = await queryOpened(hang)
    expect(evHang.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose'])
  })

  it('a document shared by overlapping queries is closed only after the last one', async () => {
    const c = new LspClient(
      { ...cmd('ok'), env: { ...process.env, FAKE_MODE: 'ok', FAKE_DEF_DELAY_MS: '400' } },
      root
    )
    clients.push(c)
    await c.start()
    const slow = c.definition(file, 1, 0, 5000)
    await c.references(file, 1, 0, 5000)
    const mid = await queryOpened(c)
    expect(mid.map((e: { kind: string }) => e.kind)).toEqual(['didOpen'])
    await slow
    const after = await queryOpened(c)
    expect(after.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose'])
  })

  it('a missing file rejects without leaving anything open', async () => {
    const c = make('ok')
    await c.start()
    await expect(c.definition(join(root, 'nope.go'), 1, 0, 5000)).rejects.toThrow()
    await c.definition(file, 1, 0, 5000)
    const events = await queryOpened(c)
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose'])
  })

  it('forwards changed files as workspace/didChangeWatchedFiles', async () => {
    const c = make('ok')
    await c.start()
    const gone = join(root, 'gone.go')
    await c.notifyFilesChanged([file, gone])
    const events = await queryOpened(c)
    const changes = events.filter((e: { kind: string }) => e.kind === 'didChangeWatchedFiles')
    expect(changes).toHaveLength(1)
    expect(changes[0].changes).toEqual([
      { uri: pathToFileURL(file).toString(), type: 2 },
      { uri: pathToFileURL(gone).toString(), type: 3 }
    ])
  })

  it('advertises didChangeWatchedFiles without dynamic registration', async () => {
    const c = make('ok')
    await c.start()
    const init = await c.sendCustomRequest('fake/initParams')
    expect(init.capabilities.workspace.didChangeWatchedFiles).toEqual({ dynamicRegistration: false })
  })

  it('notifyFilesChanged on a client that is not started is a no-op', async () => {
    const c = make('ok')
    await expect(c.notifyFilesChanged([file])).resolves.toBeUndefined()
  })

  it(
    'dispose of a server that ignores shutdown, exit and SIGTERM resolves within the bound',
    async () => {
      const c = make('nodie')
      await c.start()
      const pid = c.pid()!
      const t0 = Date.now()
      await c.dispose()
      expect(Date.now() - t0).toBeLessThan(4500)
      expect(await waitDead(pid)).toBe(true)
    },
    10_000
  )

  it('a second dispose waits for the shutdown already in progress', async () => {
    const c = make('nodie')
    await c.start()
    const pid = c.pid()!
    void c.dispose()
    await c.dispose()
    expect(alive(pid)).toBe(false)
  }, 10_000)

  it('dispose kills the child', async () => {
    const c = make('ok')
    await c.start()
    const pid = c.pid()!
    expect(alive(pid)).toBe(true)
    await c.dispose()
    expect(await waitDead(pid)).toBe(true)
    expect(c.state()).toBe('dead')
    await c.dispose() // idempotent
  })

  it('does not fire onExit when the exit was caused by dispose', async () => {
    const c = make('ok')
    await c.start()
    const pid = c.pid()!
    let fired = 0
    c.onExit(() => fired++)
    await c.dispose()
    expect(await waitDead(pid)).toBe(true)
    await new Promise((r) => setTimeout(r, 100))
    expect(fired).toBe(0)
  })

  it('start rejects with LspTimeoutError and disposes when initialize hangs', async () => {
    const c = new LspClient(cmd('init-hang'), root, { startTimeoutMs: 300 })
    clients.push(c)
    let fired = 0
    c.onExit(() => fired++)
    const err = await c.start().then(
      () => null,
      (e) => e
    )
    expect(err).toBeInstanceOf(LspTimeoutError)
    const pid = c.pid()!
    expect(await waitDead(pid)).toBe(true)
    expect(c.state()).toBe('dead')
    expect(fired).toBe(0)
  })

  it('has a generous default start deadline', () => {
    expect(START_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000)
  })

  it('sends a single didOpen for concurrent first queries on the same file', async () => {
    const c = make('ok')
    await c.start()
    await Promise.all([
      c.definition(file, 1, 0, 5000),
      c.references(file, 1, 0, 5000),
      c.definition(file, 1, 0, 5000)
    ])
    const events = await queryOpened(c)
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose'])
  })

  it('reopens once for concurrent queries after the file changed', async () => {
    const c = make('ok')
    await c.start()
    await c.definition(file, 1, 0, 5000)
    const future = new Date(Date.now() + 5000)
    utimesSync(file, future, future)
    await Promise.all([c.definition(file, 1, 0, 5000), c.references(file, 1, 0, 5000)])
    const events = await queryOpened(c)
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(['didOpen', 'didClose', 'didOpen', 'didClose'])
  })

  it('dispose before start and dispose twice are safe', async () => {
    const c = make('ok')
    await c.dispose()
    await c.dispose()
    expect(c.state()).toBe('dead')
  })
})

// Sends the custom fake/opened request through the client's own connection.
async function queryOpened(c: LspClient): Promise<any[]> {
  return c.sendCustomRequest('fake/opened')
}
