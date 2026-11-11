import { spawn, type ChildProcess } from 'child_process'
import { readFileSync, realpathSync } from 'fs'
import { access } from 'fs/promises'
import {
  createProtocolConnection,
  StreamMessageReader,
  StreamMessageWriter,
  CancellationTokenSource,
  type ProtocolConnection
} from 'vscode-languageserver-protocol/node'
import type { SymbolLocation } from '../../shared/types'
import { languageForPath, lspLocationsToSymbolLocations, toFileUri } from './translate'

export interface ServerCommand {
  command: string
  args: string[]
  env: NodeJS.ProcessEnv
  initializationOptions?: unknown
  /** Answered to workspace/configuration by section name. */
  settings?: Record<string, unknown>
}
export type ClientState = 'starting' | 'ready' | 'dead'

export class LspTimeoutError extends Error {
  constructor(message = 'LSP request timed out') {
    super(message)
    this.name = 'LspTimeoutError'
  }
}

const STDERR_KEEP = 4096
const KILL_AFTER_MS = 2000
/** After SIGKILL, how long dispose waits for the exit before giving up. */
const FORCE_EXIT_WAIT_MS = 1000
/** A server that has not finished `initialize` by then is treated as dead. */
export const START_TIMEOUT_MS = 60_000

export interface LspClientOptions {
  /** Overrides START_TIMEOUT_MS (tests). */
  startTimeoutMs?: number
}

/**
 * A document open in the server for the duration of the queries using it.
 * The viewer is read-only and keeps nothing open between queries: the last
 * query to finish sends didClose, so the next one always opens current disk
 * content.
 */
interface OpenDoc {
  refs: number
  /** Settles once didOpen has been sent. */
  ready: Promise<void>
}

/** LSP FileChangeType. */
const FILE_CHANGED = 2
const FILE_DELETED = 3

function sleep(ms: number): { p: Promise<void>; cancel: () => void } {
  let t: NodeJS.Timeout | undefined
  const p = new Promise<void>((r) => (t = setTimeout(r, ms)))
  return { p, cancel: () => clearTimeout(t) }
}

export class LspClient {
  readonly startedAt = Date.now()
  private _state: ClientState = 'starting'
  private child: ChildProcess | null = null
  private conn: ProtocolConnection | null = null
  private stderrTail = ''
  private exitCbs: Array<() => void> = []
  private dead = false
  private deadWaiters = new Set<(e: Error) => void>()
  /** Documents currently open, refcounted by in-flight queries. */
  private docs = new Map<string, OpenDoc>()
  /** Per-uri didClose in flight; a new open waits it out. */
  private closing = new Map<string, Promise<void>>()
  private nextVersion = 1
  private disposed = false
  private startPromise: Promise<void> | null = null

  private readonly startTimeoutMs: number

  constructor(
    private readonly cmd: ServerCommand,
    private readonly workspaceRoot: string,
    opts: LspClientOptions = {}
  ) {
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS
    try {
      this.realRoot = realpathSync.native(workspaceRoot)
    } catch {
      this.realRoot = workspaceRoot
    }
  }

  /** Servers report real paths; a root opened through a symlink/junction differs from it. */
  private readonly realRoot: string

  state(): ClientState {
    return this._state
  }

  pid(): number | undefined {
    return this.child?.pid
  }

  /** Fires when the server dies on its own — never for an exit caused by dispose(). */
  onExit(cb: () => void): void {
    this.exitCbs.push(cb)
  }

  start(): Promise<void> {
    if (!this.startPromise) this.startPromise = this.doStart()
    return this.startPromise
  }

  private markDead(reason: Error): void {
    if (this.dead) return
    this.dead = true
    this._state = 'dead'
    for (const rej of [...this.deadWaiters]) rej(reason)
    this.deadWaiters.clear()
    try {
      this.conn?.dispose()
    } catch {
      /* ignore */
    }
    if (this.disposed) return
    for (const cb of this.exitCbs) {
      try {
        cb()
      } catch {
        /* ignore */
      }
    }
  }

  /** Races a promise against the child dying, so nothing hangs after exit. */
  private raceDead<T>(p: Promise<T>): Promise<T> {
    if (this.dead) {
      p.catch(() => {})
      return Promise.reject(new Error('LSP server is not running'))
    }
    return new Promise<T>((resolve, reject) => {
      this.deadWaiters.add(reject)
      p.then(resolve, reject).finally(() => this.deadWaiters.delete(reject))
    })
  }

  private doStart(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (this.disposed) {
        reject(new Error('LSP client disposed'))
        return
      }
      let child: ChildProcess
      try {
        child = spawn(this.cmd.command, this.cmd.args, {
          env: this.cmd.env,
          shell: false,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (e) {
        this.markDead(e as Error)
        reject(e)
        return
      }
      this.child = child
      child.stderr?.on('data', (d: Buffer) => {
        this.stderrTail = (this.stderrTail + d.toString('utf8')).slice(-STDERR_KEEP)
      })
      child.stdin?.on('error', () => {})
      child.stdout?.on('error', () => {})

      // Reject only once the child is gone, so a rejected start always means 'dead';
      // the kill's own exit error must not mask the timeout.
      let timedOut: LspTimeoutError | null = null
      const startTimer = setTimeout(() => {
        timedOut = new LspTimeoutError(`LSP server did not initialize within ${this.startTimeoutMs}ms`)
        const err = timedOut
        void this.dispose().finally(() => reject(err))
      }, this.startTimeoutMs)
      const fail = (err: Error): void => {
        clearTimeout(startTimer)
        this.markDead(err)
        if (!timedOut) reject(err) // no-op if start already settled
      }
      child.on('error', (err) => fail(err))
      child.on('exit', (code, signal) => {
        const tail = this.stderrTail.trim()
        fail(new Error(`LSP server exited (code ${code}, signal ${signal})${tail ? `: ${tail}` : ''}`))
      })
      if (!child.stdout || !child.stdin) {
        fail(new Error('LSP server stdio unavailable'))
        return
      }

      const conn = createProtocolConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
      )
      this.conn = conn
      conn.onError(() => {})
      conn.onClose(() => {})
      conn.onRequest('workspace/configuration', (p: { items: Array<{ section?: string }> }) =>
        p.items.map((i) => (i.section !== undefined ? (this.cmd.settings?.[i.section] ?? null) : null))
      )
      conn.onRequest('window/workDoneProgress/create', () => null)
      conn.onRequest('client/registerCapability', () => null)
      conn.onRequest('client/unregisterCapability', () => null)
      conn.onNotification('window/logMessage', () => {})
      conn.onNotification('window/showMessage', () => {})
      conn.onNotification('textDocument/publishDiagnostics', () => {})
      conn.onNotification('$/progress', () => {})
      conn.listen()

      const rootUri = toFileUri(this.workspaceRoot)
      this.raceDead(
        conn.sendRequest('initialize', {
          processId: process.pid,
          rootUri,
          workspaceFolders: [{ uri: rootUri, name: 'workspace' }],
          initializationOptions: this.cmd.initializationOptions,
          capabilities: {
            workspace: {
              configuration: true,
              workspaceFolders: true,
              didChangeWatchedFiles: { dynamicRegistration: false }
            },
            window: { workDoneProgress: true },
            textDocument: {
              synchronization: { dynamicRegistration: false },
              definition: { linkSupport: true },
              references: {}
            }
          }
        })
      )
        .then(async () => {
          await conn.sendNotification('initialized', {})
          if (this.dead) return
          clearTimeout(startTimer)
          this._state = 'ready'
          resolve()
        })
        .catch((e) => fail(e as Error))
    })
  }

  /**
   * Opens `absPath` for one query (or joins a query that already has it open)
   * and returns the handle to release with releaseDoc. A query that joins an
   * in-flight open shares that content.
   */
  private async acquireDoc(absPath: string): Promise<{ uri: string; doc: OpenDoc }> {
    const uri = toFileUri(absPath)
    // Wait out any didClose in flight for this uri, then re-check.
    for (let c = this.closing.get(uri); c; c = this.closing.get(uri)) await c
    // No await between here and docs.set, so the check-and-claim is atomic.
    const existing = this.docs.get(uri)
    if (existing) {
      existing.refs++
      try {
        await existing.ready
      } catch (e) {
        void this.releaseDoc(uri, existing)
        throw e
      }
      return { uri, doc: existing }
    }
    const text = readFileSync(absPath, 'utf8') // throws before anything is claimed
    const conn = this.conn!
    const doc: OpenDoc = { refs: 1, ready: Promise.resolve() }
    doc.ready = this.raceDead(
      conn.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageForPath(absPath) ?? 'plaintext',
          version: this.nextVersion++,
          text
        }
      })
    )
    doc.ready.catch(() => {})
    this.docs.set(uri, doc)
    try {
      await doc.ready
    } catch (e) {
      // Never opened: drop it so no didClose is sent for it.
      if (this.docs.get(uri) === doc) this.docs.delete(uri)
      void this.releaseDoc(uri, doc)
      throw e
    }
    return { uri, doc }
  }

  /** The last release of a document sends didClose. Never throws. */
  private releaseDoc(uri: string, doc: OpenDoc): Promise<void> {
    doc.refs--
    if (doc.refs > 0 || this.docs.get(uri) !== doc) return Promise.resolve()
    this.docs.delete(uri)
    let sent: Promise<void>
    try {
      sent = this.conn
        ? this.raceDead(this.conn.sendNotification('textDocument/didClose', { textDocument: { uri } }))
        : Promise.resolve()
    } catch {
      sent = Promise.resolve()
    }
    const p = sent.catch(() => {})
    this.closing.set(uri, p)
    void p.finally(() => {
      if (this.closing.get(uri) === p) this.closing.delete(uri)
    })
    return p
  }

  /**
   * Tells the server files changed on disk (workspace/didChangeWatchedFiles):
   * Changed if the path exists, else Deleted. No-op unless ready; never throws.
   */
  async notifyFilesChanged(absPaths: string[]): Promise<void> {
    if (this._state !== 'ready' || !this.conn || absPaths.length === 0) return
    // Async stats: a checkout or pip install can batch thousands of paths, and sync stats
    // here would block the main process.
    const changes = await Promise.all(
      absPaths.map(async (p) => ({
        uri: toFileUri(p),
        type: await access(p).then(
          () => FILE_CHANGED,
          () => FILE_DELETED
        )
      }))
    )
    if (this._state !== 'ready' || !this.conn) return
    try {
      await this.raceDead(this.conn.sendNotification('workspace/didChangeWatchedFiles', { changes }))
    } catch {
      /* server gone; nothing to tell */
    }
  }

  private async query(
    method: 'textDocument/definition' | 'textDocument/references',
    absPath: string,
    line: number,
    column: number,
    timeoutMs: number
  ): Promise<SymbolLocation[]> {
    if (this._state !== 'ready' || !this.conn) throw new Error('LSP server is not ready')
    const conn = this.conn
    const { uri, doc } = await this.acquireDoc(absPath)
    const cts = new CancellationTokenSource()
    let timer: NodeJS.Timeout | undefined
    let request: Promise<unknown> | undefined
    try {
      const params: Record<string, unknown> = {
        textDocument: { uri },
        position: { line: line - 1, character: column }
      }
      if (method === 'textDocument/references') params.context = { includeDeclaration: true }
      request = conn.sendRequest(method, params, cts.token)
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          cts.cancel()
          reject(new LspTimeoutError(`${method} timed out after ${timeoutMs}ms`))
        }, timeoutMs)
      })
      const result = await Promise.race([this.raceDead(request), timeout])
      return lspLocationsToSymbolLocations(result as never, this.workspaceRoot, this.realRoot)
    } finally {
      clearTimeout(timer)
      cts.dispose()
      request?.catch(() => {}) // a cancelled request may reject later; never unhandled
      await this.releaseDoc(uri, doc) // success, error or timeout: close what we opened
    }
  }

  /** `line` is 1-based (SymbolLocation convention); `column` is 0-based. */
  definition(absPath: string, line: number, column: number, timeoutMs: number): Promise<SymbolLocation[]> {
    return this.query('textDocument/definition', absPath, line, column, timeoutMs)
  }

  references(absPath: string, line: number, column: number, timeoutMs: number): Promise<SymbolLocation[]> {
    return this.query('textDocument/references', absPath, line, column, timeoutMs)
  }

  /** Test hook: send an arbitrary request over the live connection. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendCustomRequest(method: string, params?: unknown): Promise<any> {
    if (!this.conn) return Promise.reject(new Error('LSP server is not running'))
    return this.raceDead(this.conn.sendRequest(method, params))
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    const child = this.child
    if (!child || this.dead) {
      this.markDead(new Error('LSP client disposed'))
      return
    }
    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null
    const exitedP = new Promise<void>((r) => {
      if (hasExited()) r()
      else child.once('exit', () => r())
    })
    const kill = (signal: NodeJS.Signals): void => {
      try {
        child.kill(signal)
      } catch {
        /* ignore */
      }
    }
    // Graceful phase, bounded by KILL_AFTER_MS: shutdown/exit for a ready
    // server, SIGTERM otherwise. Then SIGKILL and wait at most
    // FORCE_EXIT_WAIT_MS, so dispose always settles.
    const grace = sleep(KILL_AFTER_MS)
    let force: ReturnType<typeof sleep> | undefined
    try {
      let graceful: Promise<void>
      if (this._state === 'ready' && this.conn) {
        const conn = this.conn
        graceful = (async () => {
          try {
            await conn.sendRequest('shutdown')
            await conn.sendNotification('exit')
          } catch {
            /* fall through to waiting for exit */
          }
          await exitedP
        })()
      } else {
        kill('SIGTERM')
        graceful = exitedP
      }
      await Promise.race([graceful, grace.p])
      if (!hasExited()) {
        kill('SIGKILL')
        force = sleep(FORCE_EXIT_WAIT_MS)
        await Promise.race([exitedP, force.p])
      }
    } finally {
      grace.cancel()
      force?.cancel()
      this.markDead(new Error('LSP client disposed'))
    }
  }
}
