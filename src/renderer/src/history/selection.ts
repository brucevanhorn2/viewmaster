import type { HistoryVersion } from '@shared/types'

export type RevisionRef = 'baseline' | 'now' | { sha: string }

export interface Selection {
  base: RevisionRef
  compare: RevisionRef
}

export function defaultSelection(): Selection {
  return { base: 'baseline', compare: 'now' }
}

export function sameRef(a: RevisionRef, b: RevisionRef): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  return a.sha === b.sha
}

export function isDefaultSelection(s: Selection): boolean {
  return s.base === 'baseline' && s.compare === 'now'
}

/**
 * Result of clicking one row: show what that revision changed.
 * - a version → base is the immediately older version, or baseline if oldest
 * - 'now'     → base is the newest version, or baseline if none
 * - 'baseline'→ reset to the full baseline↔now diff
 * `versions` is ascending by ts.
 */
export function singleClickSelection(versions: HistoryVersion[], ref: RevisionRef): Selection {
  if (ref === 'baseline') return defaultSelection()
  if (ref === 'now') {
    const newest = versions[versions.length - 1]
    return { base: newest ? { sha: newest.sha } : 'baseline', compare: 'now' }
  }
  const idx = versions.findIndex((v) => v.sha === ref.sha)
  const prev = idx > 0 ? versions[idx - 1] : null
  return { base: prev ? { sha: prev.sha } : 'baseline', compare: { sha: ref.sha } }
}

export function baselineLabel(): string {
  return 'Baseline (git)'
}

export function nowLabel(): string {
  return 'Now'
}
