import { readFile, realpath, stat } from 'fs/promises'
import { extname, isAbsolute, relative, resolve } from 'path'

const MAX_RESOURCE_SIZE = 10 * 1024 * 1024

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.css': 'text/css'
}

function mimeFor(absPath: string): string {
  return MIME_BY_EXT[extname(absPath).toLowerCase()] ?? 'application/octet-stream'
}

/** True when `absPath` is `workspaceRoot` itself or a descendant of it. */
function isInsideRoot(absPath: string, workspaceRoot: string): boolean {
  const rel = relative(workspaceRoot, absPath)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * Reads a file for embedding in a rendered HTML preview: base64 content plus
 * an extension-inferred MIME type. Returns null for anything outside
 * `workspaceRoot`, missing, oversized, or unreadable — callers treat null as
 * "leave this reference unresolved," not as an error to surface.
 */
export async function readResource(
  absPath: string,
  workspaceRoot: string
): Promise<{ base64: string; mime: string } | null> {
  // Resolve to real paths (following symlinks) to prevent symlink escape attacks
  let realAbsPath: string
  let realRoot: string
  try {
    realAbsPath = await realpath(absPath)
    realRoot = await realpath(workspaceRoot)
  } catch {
    // realpath fails on missing files or broken symlinks
    return null
  }

  // Check that the real path is inside the real workspace root
  if (!isInsideRoot(realAbsPath, realRoot)) return null

  let size: number
  try {
    const info = await stat(realAbsPath)
    if (!info.isFile()) return null
    size = info.size
  } catch {
    return null
  }
  if (size > MAX_RESOURCE_SIZE) return null

  try {
    const buffer = await readFile(realAbsPath)
    return { base64: buffer.toString('base64'), mime: mimeFor(realAbsPath) }
  } catch {
    return null
  }
}
