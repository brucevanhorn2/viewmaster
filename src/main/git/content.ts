import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import type { FileContent } from '@shared/types'
import { runGit } from './run'

const MAX_SIZE = 2 * 1024 * 1024
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const BINARY_SNIFF_BYTES = 8192

const RASTER_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

/** Read a file from disk, classifying image / binary / oversized / missing content. */
export async function readCurrentFile(absPath: string): Promise<FileContent> {
  let size: number
  try {
    const info = await stat(absPath)
    if (!info.isFile()) return { kind: 'missing' }
    size = info.size
  } catch {
    return { kind: 'missing' }
  }

  const rasterMime = RASTER_IMAGE_MIME[extname(absPath).toLowerCase()]
  if (rasterMime) {
    if (size > MAX_IMAGE_SIZE) return { kind: 'too-large', size }
    try {
      const buffer = await readFile(absPath)
      return { kind: 'image', mime: rasterMime, base64: buffer.toString('base64') }
    } catch {
      return { kind: 'missing' }
    }
  }

  if (size > MAX_SIZE) return { kind: 'too-large', size }

  let buffer: Buffer
  try {
    buffer = await readFile(absPath)
  } catch {
    return { kind: 'missing' }
  }

  const sniff = buffer.subarray(0, BINARY_SNIFF_BYTES)
  if (sniff.includes(0)) return { kind: 'binary' }

  return { kind: 'text', content: buffer.toString('utf8') }
}

/**
 * Baseline content via `git show <base>:<path>`. Empty string when there is
 * no baseline or the path did not exist at it — an untracked/added file then
 * diffs as all-added.
 */
export async function readBaseFile(
  root: string,
  base: string | null,
  relPath: string
): Promise<string> {
  if (!base) return ''
  const res = await runGit(root, ['show', `${base}:${relPath}`])
  return res.code === 0 ? res.stdout : ''
}
