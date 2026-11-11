import { spawn, type ChildProcess } from 'child_process'
import { statSync, readFileSync } from 'fs'
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
/** A server that has not finished `initialize` by then is treated as dead. */
export const START_TIMEOUT_MS = 60_000

export interface LspClientOptions {
  /** Overrides START_TIMEOUT_MS (tests). */
  startTimeoutMs?: number
}

interface OpenDoc {
  version: number
  mtimeMs: number
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
  private open = new Map<string, OpenDoc>()
  /** Per-uri didOpen/didClose in progress, so concurrent queries never double-open. */
  private opening = new Map<string, Promise<void>>()
  private disposed = false
  private startPromise: Promise<void> | null = null

  private readonly startTimeoutMs: number

  constructor(
    private readonly cmd: ServerCommand,
    private readonly workspaceRoot: string,
    opts: LspClientOptions = {}
  ) {
    this.startTimeoutMs = opts.startTimeoutMs ?? START_TIMEOUT_MS
  }

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
            workspace: { configuration: true, workspaceFolders: true },
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

  private async ensureOpen(absPath: string): Promise<string> {
    const uri = toFileUri(absPath)
    // Wait out any open/reopen already in flight for this uri, then re-check.
    for (let inflight = this.opening.get(uri); inflight; inflight = this.opening.get(uri)) {
      await inflight.catch(() => {})
    }
    // No await between here and opening.set, so the check-and-claim is atomic.
    const mtimeMs = statSync(absPath).mtimeMs
    const existing = this.open.get(uri)
    if (existing && existing.mtimeMs === mtimeMs) return uri
    const conn = this.conn!
    const p = (async (): Promise<void> => {
      if (existing) {
        this.open.delete(uri)
        await conn.sendNotification('textDocument/didClose', { textDocument: { uri } })
      }
      const version = (existing?.version ?? 0) + 1
      await conn.sendNotification('textDocument/didOpen', {
        textDocument: {
          uri,
          languageId: languageForPath(absPath) ?? 'plaintext',
          version,
          text: readFileSync(absPath, 'utf8')
        }
      })
      this.open.set(uri, { version, mtimeMs })
    })()
    this.opening.set(uri, p)
    try {
      await p
    } finally {
      if (this.opening.get(uri) === p) this.opening.delete(uri)
    }
    return uri
  }

  private async query(
    method: 'textDocument/definition' | 'textDocument/references',
    absPath: string,
    line: number,
    column: number,
    timeoutMs: number
  ): Promise<SymbolLocation[]> {
    if (this._state !== 'ready' || !this.conn) throw new Error('LSP server is not ready')
    const uri = await this.ensureOpen(absPath)
    const cts = new CancellationTokenSource()
    let timer: NodeJS.Timeout | undefined
    const params: Record<string, unknown> = {
      textDocument: { uri },
      position: { line: line - 1, character: column }
    }
    if (method === 'textDocument/references') params.context = { includeDeclaration: true }
    const request = this.conn.sendRequest(method, params, cts.token)
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        cts.cancel()
        reject(new LspTimeoutError(`${method} timed out after ${timeoutMs}ms`))
      }, timeoutMs)
    })
    try {
      const result = await Promise.race([this.raceDead(request), timeout])
      return lspLocationsToSymbolLocations(result as never, this.workspaceRoot)
    } finally {
      clearTimeout(timer)
      cts.dispose()
      request.catch(() => {}) // a cancelled request may reject later; never unhandled
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
    let killTimer: NodeJS.Timeout | undefined
    const killP = new Promise<void>((r) => {
      killTimer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        r()
      }, KILL_AFTER_MS)
    })
    try {
      if (this._state === 'ready' && this.conn) {
        const conn = this.conn
        await Promise.race([
          (async () => {
            await conn.sendRequest('shutdown')
            await conn.sendNotification('exit')
          })().catch(() => {}),
          killP
        ])
      } else {
        child.kill()
      }
      await Promise.race([exitedP, killP])
      if (!hasExited()) {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        await exitedP
      }
    } finally {
      clearTimeout(killTimer)
      this.markDead(new Error('LSP client disposed'))
    }
  }
}
