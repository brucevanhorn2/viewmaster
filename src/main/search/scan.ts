import { createReadStream } from 'fs'
import { open, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import type { SearchMatch } from '@shared/types'
import { BINARY_SNIFF_BYTES, MAX_SIZE } from '../git/content'

const CONCURRENCY = 24
const MAX_MATCHES_PER_FILE = 50
const MAX_MATCHES_TOTAL = 500
const COMPACTION_THRESHOLD = MAX_MATCHES_TOTAL * 4
const TIME_BUDGET_MS = 10000
const PREVIEW_MAX_LENGTH = 200
const PREVIEW_CONTEXT = 60

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function compareMatches(a: SearchMatch, b: SearchMatch): number {
  return a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column
}

export interface SearchScanOptions {
  signal?: AbortSignal
  startedAt?: number
  mode?: 'substring' | 'word'
  caseSensitive?: boolean
  lineFilter?: (line: string) => boolean
  /** When set (with mode: 'word'), matches ANY of these words instead of
   * `query` — each independently \b-bounded. `query` is still required
   * non-empty (used only for the early-exit check on blank input). */
  words?: string[]
}

export interface SearchScanResult {
  matches: SearchMatch[]
  truncated: boolean
}

/** True when the first BINARY_SNIFF_BYTES of `absPath` contain a NUL byte. */
async function isBinaryFile(absPath: string): Promise<boolean> {
  const handle = await open(absPath, 'r')
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0)
    return buffer.subarray(0, bytesRead).includes(0)
  } finally {
    await handle.close()
  }
}

/**
 * Extracts a display snippet around a match, capped to PREVIEW_MAX_LENGTH.
 * For a line short enough to fit whole, `previewColumn` equals `column`;
 * for a longer line, the snippet is centered around the match (with
 * PREVIEW_CONTEXT characters of leading context where available) so a
 * match far into a long/minified line is never cut out of the preview.
 */
function extractPreview(line: string, column: number): { preview: string; previewColumn: number } {
  if (line.length <= PREVIEW_MAX_LENGTH) return { preview: line, previewColumn: column }
  const start = Math.max(0, column - PREVIEW_CONTEXT)
  const end = Math.min(line.length, start + PREVIEW_MAX_LENGTH)
  return { preview: line.slice(start, end), previewColumn: column - start }
}

/**
 * Scans one file for up to `maxMatches` occurrences of `needle` (already
 * lowercased unless `caseSensitive`). `capped` is true when the file had
 * more matches than `maxMatches` allowed for (used by the caller to mark
 * the overall result `truncated`). When `lineFilter` is given, a line is
 * skipped entirely (not counted, not searched) unless the filter accepts it.
 */
async function scanOneFile(
  absPath: string,
  relPath: string,
  needle: string,
  maxMatches: number,
  mode: 'substring' | 'word',
  caseSensitive: boolean,
  lineFilter?: (line: string) => boolean,
  words?: string[]
): Promise<{ matches: SearchMatch[]; capped: boolean }> {
  if (maxMatches <= 0) return { matches: [], capped: false }

  try {
    const info = await stat(absPath)
    if (!info.isFile() || info.size === 0 || info.size > MAX_SIZE) {
      return { matches: [], capped: false }
    }
  } catch {
    return { matches: [], capped: false }
  }

  try {
    if (await isBinaryFile(absPath)) return { matches: [], capped: false }
  } catch {
    return { matches: [], capped: false }
  }

  const results: SearchMatch[] = []
  let capped = false
  const wordPattern =
    mode === 'word'
      ? new RegExp(
          (words && words.length > 0 ? words : [needle]).map((w) => `\\b${escapeRegExp(w)}\\b`).join('|'),
          caseSensitive ? 'g' : 'gi'
        )
      : null
  const stream = createReadStream(absPath, { encoding: 'utf8' })
  const rl = createInterface({
    input: stream,
    crlfDelay: Infinity
  })
  let lineNumber = 0
  try {
    try {
      outer: for await (const line of rl) {
        lineNumber++
        if (lineFilter && !lineFilter(line)) continue
        if (wordPattern) {
          wordPattern.lastIndex = 0
          let match: RegExpExecArray | null
          while ((match = wordPattern.exec(line)) !== null) {
            const { preview, previewColumn } = extractPreview(line, match.index)
            results.push({
              path: relPath,
              absPath,
              line: lineNumber,
              column: match.index,
              preview,
              previewColumn
            })
            if (results.length >= maxMatches) {
              capped = true
              break outer
            }
          }
        } else {
          const column = caseSensitive ? line.indexOf(needle) : line.toLowerCase().indexOf(needle)
          if (column === -1) continue
          const { preview, previewColumn } = extractPreview(line, column)
          results.push({ path: relPath, absPath, line: lineNumber, column, preview, previewColumn })
          if (results.length >= maxMatches) {
            capped = true
            break outer
          }
        }
      }
    } catch {
      // Stream error (file deleted, permissions changed, etc.) — skip this file,
      // don't fail the entire search. Return whatever matches were found so far.
    }
  } finally {
    rl.close()
    stream.destroy()
  }
  return { matches: results, capped }
}

/** Runs `worker` over `items` with at most `concurrency` running at once. */
async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  let cursor = 0
  const next = (): T | undefined => (cursor < items.length ? items[cursor++] : undefined)
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    for (;;) {
      const item = next()
      if (item === undefined) return
      await worker(item)
    }
  })
  await Promise.all(workers)
}

/**
 * Live, bounded-concurrency substring search over `paths` (already
 * gitignore-filtered, relative to `root`) — no persistent index or cache;
 * every call reads current on-disk content. Case-insensitive plain
 * substring matching, capped at MAX_MATCHES_PER_FILE per file. Every
 * dispatched file scans to completion (bounded by its own per-file cap
 * and the TIME_BUDGET_MS wall-clock budget below) — the result is then
 * sorted by (path, line, column) and sliced to MAX_MATCHES_TOTAL if
 * longer, so both the match order and which matches survive truncation
 * are deterministic for a given file set and query, independent of
 * worker-completion timing. Determinism (both here and when the time
 * budget below cuts scanning short) assumes `paths` is already sorted
 * the same way the final result is — true for every current caller,
 * since `getSearchPaths` sources from `listGitTree`/`listFolderTree`,
 * which already sort. `options.signal`, if already aborted or
 * aborted mid-scan, stops dispatching new file scans promptly (a file
 * scan already in flight when the abort happens is not cancelled
 * mid-file).
 */
export async function searchFiles(
  root: string,
  paths: string[],
  query: string,
  options: SearchScanOptions = {}
): Promise<SearchScanResult> {
  if (query.trim() === '') return { matches: [], truncated: false }
  const caseSensitive = options.caseSensitive ?? false
  const needle = caseSensitive ? query : query.toLowerCase()
  const mode = options.mode ?? 'substring'
  const lineFilter = options.lineFilter
  const matches: SearchMatch[] = []
  let truncated = false
  const startedAt = options.startedAt ?? Date.now()
  const signal = options.signal

  await runWithConcurrency(paths, CONCURRENCY, async (relPath) => {
    if (signal?.aborted) return
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      truncated = true
      return
    }
    const absPath = join(root, relPath)
    const { matches: fileMatches, capped } = await scanOneFile(
      absPath,
      relPath,
      needle,
      MAX_MATCHES_PER_FILE,
      mode,
      caseSensitive,
      lineFilter,
      options.words
    )
    matches.push(...fileMatches)
    if (capped) truncated = true
    if (matches.length > COMPACTION_THRESHOLD) {
      matches.sort(compareMatches)
      matches.length = MAX_MATCHES_TOTAL
      truncated = true
    }
  })

  matches.sort(compareMatches)
  if (matches.length > MAX_MATCHES_TOTAL) {
    matches.length = MAX_MATCHES_TOTAL
    truncated = true
  }

  return { matches, truncated }
}
