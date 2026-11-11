import type { ExternalKind } from '@shared/types'

const LABELS: Record<ExternalKind, string> = {
  'go-stdlib': 'Go standard library',
  'go-modcache': 'Go module cache',
  'python-venv': 'Python venv',
  'python-stubs': 'Python stubs'
}

/** Toolbar label for a file that lives outside the opened folder. */
export function externalLabel(kind: ExternalKind): string {
  return LABELS[kind]
}
