import { execFile } from 'child_process'
import { readFile, stat } from 'fs/promises'
import { extname } from 'path'
import type { FileContent } from '@shared/types'
import { runGit } from './run'
import { MAX_RESOURCE_SIZE } from '../files/resource'

export const MAX_SIZE = 2 * 1024 * 1024
const MAX_IMAGE_SIZE = 10 * 1024 * 1024
const MAX_PDF_SIZE = 25 * 1024 * 1024
export const BINARY_SNIFF_BYTES = 8192

const RASTER_IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp'
}

const PDF_EXTENSION = '.pdf'

/** True when a path's extension is a recognized raster image type. */
export function isRasterImagePath(path: string): boolean {
  return extname(path).toLowerCase() in RASTER_IMAGE_MIME
}

/** True when a path's extension is `.pdf` (case-insensitive). */
export function isPdfPath(path: string): boolean {
  return extname(path).toLowerCase() === PDF_EXTENSION
}

/** Read a file from disk, classifying image / PDF / binary / oversized / missing content. */
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

  if (isPdfPath(absPath)) {
    if (size > MAX_PDF_SIZE) return { kind: 'too-large', size }
    try {
      const buffer = await readFile(absPath)
      return { kind: 'pdf', base64: buffer.toString('base64') }
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

function gitBuffer(root: string, args: string[]): Promise<Buffer | null> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd: root, maxBuffer: MAX_RESOURCE_SIZE + 1024, encoding: 'buffer' },
      (err, stdout) => resolve(err ? null : stdout)
    )
  })
}

/**
 * Raw bytes of `<base>:<relPath>` when that object is a blob. Null when there
 * is no baseline, the path is missing or not a blob (e.g. a directory), git
 * fails, or the blob exceeds MAX_RESOURCE_SIZE.
 */
export async function readBaseBlob(
  root: string,
  base: string | null,
  relPath: string
): Promise<Buffer | null> {
  if (!base) return null
  const spec = `${base}:${relPath}`
  const type = await gitBuffer(root, ['cat-file', '-t', spec])
  if (!type || type.toString('utf8').trim() !== 'blob') return null
  const buf = await gitBuffer(root, ['show', spec])
  if (!buf || buf.length > MAX_RESOURCE_SIZE) return null
  return buf
}
