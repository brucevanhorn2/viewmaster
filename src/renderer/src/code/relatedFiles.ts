import type { SymbolLocation } from '@shared/types'

export interface RelatedFile {
  path: string
  absPath: string
}

/**
 * Merges symbol-location results for multiple declared names (or a
 * single-array `related:importedBy` result) into one row per related
 * file, excluding matches inside the file being viewed itself
 * (`ownAbsPath`), sorted by path for stable, readable display.
 */
export function aggregateReferences(results: SymbolLocation[][], ownAbsPath: string): RelatedFile[] {
  const byPath = new Map<string, RelatedFile>()
  for (const locations of results) {
    for (const loc of locations) {
      if (loc.absPath === ownAbsPath) continue
      if (!byPath.has(loc.absPath)) {
        byPath.set(loc.absPath, { path: loc.path, absPath: loc.absPath })
      }
    }
  }
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path))
}
