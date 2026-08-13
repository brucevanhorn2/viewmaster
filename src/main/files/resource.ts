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
 * Resolves `absPath` and `workspaceRoot` to their real (symlink-following)
 * paths and returns the real path of `absPath` when it's inside the real
 * workspace root — null otherwise (including when either path can't be
 * resolved, e.g. missing files or broken symlinks). Shared containment check
 * for anything that hands a renderer-supplied path to a main-process API;
 * callers treat null as "refuse silently," not as an error to surface.
 */
export async function resolveWithinRoot(
  absPath: string,
  workspaceRoot: string
): Promise<string | null> {
  let realAbsPath: string
  let realRoot: string
  try {
    realAbsPath = await realpath(absPath)
    realRoot = await realpath(workspaceRoot)
  } catch {
    // realpath fails on missing files or broken symlinks
    return null
  }

  return isInsideRoot(realAbsPath, realRoot) ? realAbsPath : null
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
  const realAbsPath = await resolveWithinRoot(absPath, workspaceRoot)
  if (!realAbsPath) return null

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
