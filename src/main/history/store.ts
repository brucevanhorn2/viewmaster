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
