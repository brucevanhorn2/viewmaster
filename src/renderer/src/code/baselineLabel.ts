import type { BaselineKind } from '@shared/types'

/** Human-readable label for the sidebar header's baseline display. */
export function baselineLabel(b: BaselineKind): string {
  if (b.kind === 'merge-base') return `${b.branch} vs ${b.defaultBranch}`
  if (b.kind === 'custom') return `Custom: ${b.ref}`
  const reasons: Record<string, string> = {
    detached: 'detached HEAD',
    'on-default': `on ${b.branch ?? 'default branch'}`,
    'no-commits': 'no commits yet',
    'no-baseline': 'no baseline branch'
  }
  return `Working tree changes only (${reasons[b.reason]})`
}
