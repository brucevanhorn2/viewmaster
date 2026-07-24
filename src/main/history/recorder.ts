import { createHash } from 'crypto'
import { readdir } from 'fs/promises'
import { join } from 'path'
import type { HistoryVersion } from '@shared/types'
import { readCurrentFile } from '../git/content'
import { runGit } from '../git/run'
import { historyPaths } from './paths'
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
      const pending = new Set<string>([...settleTimers.keys(), ...maxTimers.keys()])
      for (const relPath of pending) fire(relPath)
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
