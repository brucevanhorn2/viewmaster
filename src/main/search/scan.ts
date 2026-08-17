import { createReadStream } from 'fs'
import { open, stat } from 'fs/promises'
import { createInterface } from 'readline'
import { join } from 'path'
import type { SearchMatch } from '@shared/types'
import { BINARY_SNIFF_BYTES, MAX_SIZE } from '../git/content'

const CONCURRENCY = 24
const MAX_MATCHES_PER_FILE = 50
const MAX_MATCHES_TOTAL = 500
const TIME_BUDGET_MS = 10000
const PREVIEW_MAX_LENGTH = 200
const PREVIEW_CONTEXT = 60

export interface SearchScanOptions {
  signal?: AbortSignal
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
 * lowercased). `capped` is true when the file had more matches than
 * `maxMatches` allowed for (used by the caller to mark the overall result
 * `truncated`).
 */
async function scanOneFile(
  absPath: string,
  relPath: string,
  needle: string,
  maxMatches: number
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
  const rl = createInterface({
    input: createReadStream(absPath, { encoding: 'utf8' }),
    crlfDelay: Infinity
  })
  let lineNumber = 0
  try {
    for await (const line of rl) {
      lineNumber++
      const column = line.toLowerCase().indexOf(needle)
      if (column === -1) continue
      const { preview, previewColumn } = extractPreview(line, column)
      results.push({ path: relPath, absPath, line: lineNumber, column, preview, previewColumn })
      if (results.length >= maxMatches) {
        capped = true
        break
      }
    }
  } finally {
    rl.close()
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
 * substring matching, capped at MAX_MATCHES_PER_FILE per file and
 * MAX_MATCHES_TOTAL overall (soft caps under concurrency — may overshoot
 * slightly before all workers notice; that's fine, this is a safety valve,
 * not an invariant anything else depends on), plus a TIME_BUDGET_MS
 * wall-clock budget as a second, independent guard against a
 * pathologically large folder. `options.signal`, if already aborted or
 * aborted mid-scan, stops dispatching new file scans promptly (a file scan
 * already in flight when the abort happens is not cancelled mid-file).
 */
export async function searchFiles(
  root: string,
  paths: string[],
  query: string,
  options: SearchScanOptions = {}
): Promise<SearchScanResult> {
  if (query.trim() === '') return { matches: [], truncated: false }
  const needle = query.toLowerCase()
  const matches: SearchMatch[] = []
  let truncated = false
  const startedAt = Date.now()
  const signal = options.signal

  await runWithConcurrency(paths, CONCURRENCY, async (relPath) => {
    if (signal?.aborted) return
    if (matches.length >= MAX_MATCHES_TOTAL) {
      truncated = true
      return
    }
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      truncated = true
      return
    }
    const perFileCap = Math.min(MAX_MATCHES_PER_FILE, MAX_MATCHES_TOTAL - matches.length)
    const absPath = join(root, relPath)
    const { matches: fileMatches, capped } = await scanOneFile(absPath, relPath, needle, perFileCap)
    matches.push(...fileMatches)
    if (capped) truncated = true
  })

  return { matches, truncated }
}
