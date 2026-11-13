import { extname, join, relative, sep } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import type { Location, LocationLink } from 'vscode-languageserver-protocol'
import type { LspLanguage, SymbolLocation } from '../../shared/types'
import { isInsideRoot } from '../files/resource'

export function toFileUri(absPath: string): string {
  return pathToFileURL(absPath).toString()
}

export function languageForPath(absPath: string): LspLanguage | null {
  const ext = extname(absPath).toLowerCase()
  if (ext === '.go') return 'go'
  if (ext === '.py' || ext === '.pyi') return 'python'
  return null
}

function isLocationLink(l: Location | LocationLink): l is LocationLink {
  return 'targetUri' in l
}

function toSymbolLocation(
  uri: string,
  line0: number,
  character: number,
  workspaceRoot: string,
  realRoot: string
): SymbolLocation | null {
  let fsPath: string
  try {
    fsPath = fileURLToPath(uri)
  } catch {
    return null // non-file URI (e.g. untitled:, jar:)
  }
  const line = line0 + 1
  const base = isInsideRoot(fsPath, workspaceRoot)
    ? workspaceRoot
    : realRoot !== workspaceRoot && isInsideRoot(fsPath, realRoot)
      ? realRoot
      : null
  if (base) {
    const rel = relative(base, fsPath)
    // join() against the caller's root keeps its drive-letter casing, which
    // is what the tree listing / renderer use for absPath.
    return { path: rel.split(sep).join('/'), absPath: join(workspaceRoot, rel), line, column: character }
  }
  const absPath =
    process.platform === 'win32' ? fsPath.replace(/^[a-z]:/, (d) => d.toUpperCase()) : fsPath
  return { path: absPath.split(sep).join('/'), absPath, line, column: character }
}

/**
 * Converts an LSP definition/reference answer into SymbolLocations. In-root
 * files get a repo-relative `path`; files outside get their absolute path
 * with forward slashes. Duplicates (same absPath:line:column) are dropped.
 * `realRoot` (the root's realpath) maps answers reported through a resolved
 * symlink/junction back under `workspaceRoot`.
 */
export function lspLocationsToSymbolLocations(
  result: Location | Location[] | LocationLink[] | null,
  workspaceRoot: string,
  realRoot: string = workspaceRoot
): SymbolLocation[] {
  if (!result) return []
  const items: Array<Location | LocationLink> = Array.isArray(result) ? result : [result]
  const out: SymbolLocation[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const [uri, pos] = isLocationLink(item)
      ? [item.targetUri, item.targetSelectionRange.start]
      : [item.uri, item.range.start]
    const loc = toSymbolLocation(uri, pos.line, pos.character, workspaceRoot, realRoot)
    if (!loc) continue
    const key = `${loc.absPath}:${loc.line}:${loc.column}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(loc)
  }
  return out
}
