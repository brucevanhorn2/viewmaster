import type { BaselineKind } from '../../../shared/types'

/** Stable identity of the active baseline; changes whenever the git ref images are read from changes. */
export function baselineKey(baseline: BaselineKind | null | undefined): string {
  if (!baseline) return 'none'
  if (baseline.kind === 'merge-base') return `merge-base:${baseline.base}`
  if (baseline.kind === 'custom') return `custom:${baseline.ref}`
  return 'working-only'
}
