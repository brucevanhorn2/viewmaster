import type { ApproximateReason, LspLanguage, SymbolLocation, SymbolQuery } from '../../shared/types'
import type { ExternalRoot } from '../files/externalRoots'
import { LspClient, LspTimeoutError, type ServerCommand } from './client'
import {
  externalRootsFor as realExternalRootsFor,
  findGopls,
  findVenvPython,
  goplsCommand,
  pyrightCommand
} from './servers'
import { languageForPath } from './translate'

/** Overall budget per query, including any wait for the server to start. */
export const QUERY_TIMEOUT_MS = 4000
/** A timeout within this window of start = 'starting', after = 'unavailable'. */
export const STARTING_GRACE_MS = 120_000
/** Replacements of a dead client before the language is given up for this folder. */
export const MAX_RESTARTS = 3
/** How long a "server not installed" verdict is trusted before re-checking. */
const NOT_INSTALLED_RECHECK_MS = 30_000

export type LspAnswer =
  | { kind: 'answer'; locations: SymbolLocation[] }
  | { kind: 'fallback'; reason: ApproximateReason }

export interface ManagerDeps {
  commandFor(lang: LspLanguage): Promise<ServerCommand | null>
  createClient?(cmd: ServerCommand, root: string): LspClient
  /** Allow-list roots computed when a language starts; defaults to servers.externalRootsFor. */
  externalRootsFor?(lang: LspLanguage, root: string): Promise<ExternalRoot[]>
}

const UNAVAILABLE: LspAnswer = { kind: 'fallback', reason: 'unavailable' }

interface Instance {
  client: LspClient
  /** Resolves once the server is initialized and its external roots are cached. */
  ready: Promise<void>
  failed: boolean
}

interface Slot {
  instance: Instance | null
  /** createClient calls so far: 1 initial + replacements. */
  spawns: number
  acquiring: Promise<Instance | ApproximateReason> | null
  notInstalledAt: number | null
  roots: ExternalRoot[]
}

/**
 * One lazily started language server per language for one workspace folder.
 * Never throws from query(): every failure is a labelled fallback.
 */
export class LspManager {
  private readonly slots = new Map<LspLanguage, Slot>()
  private readonly allClients = new Set<LspClient>()
  private readonly pending = new Set<(a: LspAnswer) => void>()
  private disposed = false

  constructor(
    private readonly workspaceRoot: string,
    private readonly deps: ManagerDeps
  ) {}

  query(kind: 'definition' | 'references', q: SymbolQuery): Promise<LspAnswer> {
    const lang = languageForPath(q.absPath)
    if (this.disposed || !lang) return Promise.resolve(UNAVAILABLE)
    return new Promise<LspAnswer>((resolve) => {
      let instance: Instance | null = null
      const finish = (a: LspAnswer): void => {
        if (!this.pending.delete(finish)) return // already settled
        clearTimeout(timer)
        resolve(a)
      }
      this.pending.add(finish)
      const deadline = Date.now() + QUERY_TIMEOUT_MS
      const timer = setTimeout(() => finish(this.timeoutAnswer(instance)), QUERY_TIMEOUT_MS)
      this.run(kind, q, lang, deadline, (i) => (instance = i)).then(finish, (e) =>
        finish(e instanceof LspTimeoutError ? this.timeoutAnswer(instance) : UNAVAILABLE)
      )
    })
  }

  /**
   * Forwards on-disk changes (absolute paths) to every server that is running,
   * as workspace/didChangeWatchedFiles. Never starts a server; never throws.
   * Every path goes to every running server, unfiltered by extension, since
   * go.mod / pyproject.toml changes matter too.
   */
  notifyFilesChanged(absPaths: string[]): void {
    if (this.disposed || absPaths.length === 0) return
    for (const slot of this.slots.values()) {
      const i = slot.instance
      if (!i || i.failed || i.client.state() !== 'ready') continue
      try {
        void i.client.notifyFilesChanged(absPaths).catch(() => {})
      } catch {
        /* ignore */
      }
    }
  }

  externalRoots(): ExternalRoot[] {
    return [...this.slots.values()].flatMap((s) => s.roots)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    for (const finish of [...this.pending]) finish(UNAVAILABLE)
    await Promise.all([...this.allClients].map((c) => c.dispose().catch(() => {})))
  }

  private timeoutAnswer(instance: Instance | null): LspAnswer {
    // Still resolving the command (no client yet) counts as starting.
    if (!instance) return { kind: 'fallback', reason: 'starting' }
    const age = Date.now() - instance.client.startedAt
    return { kind: 'fallback', reason: age < STARTING_GRACE_MS ? 'starting' : 'unavailable' }
  }

  private async run(
    kind: 'definition' | 'references',
    q: SymbolQuery,
    lang: LspLanguage,
    deadline: number,
    setInstance: (i: Instance) => void
  ): Promise<LspAnswer> {
    const got = await this.acquire(lang)
    if (typeof got === 'string') return { kind: 'fallback', reason: got }
    setInstance(got)
    try {
      await got.ready
    } catch {
      return UNAVAILABLE // start failure (incl. start deadline) is never 'starting'
    }
    if (this.disposed) return UNAVAILABLE
    const remaining = deadline - Date.now()
    if (remaining <= 0) throw new LspTimeoutError()
    const locations =
      kind === 'definition'
        ? await got.client.definition(q.absPath, q.line, q.column, remaining)
        : await got.client.references(q.absPath, q.line, q.column, remaining)
    return { kind: 'answer', locations }
  }

  private slot(lang: LspLanguage): Slot {
    let s = this.slots.get(lang)
    if (!s) {
      s = { instance: null, spawns: 0, acquiring: null, notInstalledAt: null, roots: [] }
      this.slots.set(lang, s)
    }
    return s
  }

  private isDead(i: Instance): boolean {
    return i.failed || i.client.state() === 'dead'
  }

  private acquire(lang: LspLanguage): Promise<Instance | ApproximateReason> {
    const slot = this.slot(lang)
    if (slot.instance && !this.isDead(slot.instance)) return Promise.resolve(slot.instance)
    if (!slot.acquiring) {
      // Stored synchronously so concurrent first queries share one spawn.
      const p = this.spawn(lang, slot)
      slot.acquiring = p
      void p
        .finally(() => {
          if (slot.acquiring === p) slot.acquiring = null
        })
        .catch(() => {}) // the query that awaits `p` handles its rejection
    }
    return slot.acquiring
  }

  private async spawn(lang: LspLanguage, slot: Slot): Promise<Instance | ApproximateReason> {
    const old = slot.instance
    if (old) {
      slot.instance = null
      void old.client.dispose().catch(() => {})
    }
    if (slot.spawns >= 1 + MAX_RESTARTS) return 'unavailable'
    if (slot.notInstalledAt !== null && Date.now() - slot.notInstalledAt < NOT_INSTALLED_RECHECK_MS) {
      return 'not-installed'
    }
    let cmd: ServerCommand | null
    try {
      cmd = await this.deps.commandFor(lang)
    } catch {
      slot.spawns++ // a broken command is a start failure; it consumes the budget
      return 'unavailable'
    }
    if (this.disposed) return 'unavailable'
    if (!cmd) {
      slot.notInstalledAt = Date.now()
      return 'not-installed'
    }
    slot.notInstalledAt = null
    slot.spawns++
    const client = this.deps.createClient
      ? this.deps.createClient(cmd, this.workspaceRoot)
      : new LspClient(cmd, this.workspaceRoot)
    this.allClients.add(client)
    const rootsFor = this.deps.externalRootsFor ?? ((l: LspLanguage, r: string) => realExternalRootsFor(l, r, process.env))
    const instance: Instance = { client, failed: false, ready: Promise.resolve() }
    // Roots are part of readiness, so a file:read for an answer's external
    // location can never race the cache.
    instance.ready = Promise.all([
      client.start(),
      rootsFor(lang, this.workspaceRoot).then(
        (roots) => {
          slot.roots = roots
        },
        () => {}
      )
    ]).then(
      () => {},
      (e) => {
        instance.failed = true
        throw e
      }
    )
    instance.ready.catch(() => {})
    slot.instance = instance
    return instance
  }
}

/** Production manager: user's gopls, bundled pyright with the workspace venv. */
export function createLspManager(workspaceRoot: string): LspManager {
  return new LspManager(workspaceRoot, {
    async commandFor(lang) {
      if (lang === 'go') {
        const gopls = await findGopls(process.env)
        return gopls ? goplsCommand(gopls, process.env) : null
      }
      return pyrightCommand(await findVenvPython(workspaceRoot))
    }
  })
}
