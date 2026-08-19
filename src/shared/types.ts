export type FileStatus = 'untracked' | 'modified' | 'staged' | 'committed' | 'unchanged'

/** Priority order for primary status: highest ("most live") wins. */
export const STATUS_PRIORITY: FileStatus[] = ['untracked', 'modified', 'staged', 'committed']

export interface ChangedFile {
  /** Repo-relative path, forward slashes. */
  path: string
  absPath: string
  /** Primary (highest-priority) status. */
  status: FileStatus
  /** Next-highest status also present, if any. */
  secondary?: FileStatus
}

export type BaselineKind =
  | { kind: 'merge-base'; base: string; defaultBranch: string; branch: string }
  | {
      kind: 'working-only'
      reason: 'detached' | 'on-default' | 'no-commits' | 'no-baseline'
      branch?: string
    }

export type SidebarMode = 'changed' | 'browse'

export type RepoState =
  | { kind: 'repo'; root: string; baseline: BaselineKind; mode: SidebarMode; files: ChangedFile[] }
  | { kind: 'folder'; root: string; files: ChangedFile[] }
  | { kind: 'error'; root: string; message: string }

export type FileContent =
  | { kind: 'text'; content: string }
  | { kind: 'image'; mime: string; base64: string }
  | { kind: 'pdf'; base64: string }
  | { kind: 'binary' }
  | { kind: 'too-large'; size: number }
  | { kind: 'missing' }

export interface HistoryVersion {
  /** Capture time, epoch milliseconds. */
  ts: number
  /** sha256 hex of the captured content (object key). */
  sha: string
  /** Byte length of the captured content. */
  size: number
}

export interface SearchMatch {
  /** Repo-relative path, forward slashes. */
  path: string
  absPath: string
  /** 1-based line number. */
  line: number
  /** 0-based character offset of the match within the full line. */
  column: number
  /** Display snippet of the line, re-centered/truncated for very long lines. */
  preview: string
  /** 0-based character offset of the match within `preview`. */
  previewColumn: number
}

export interface SearchResult {
  matches: SearchMatch[]
  truncated: boolean
  error?: string
}

export interface SymbolLocation {
  /** Repo-relative path, forward slashes. */
  path: string
  absPath: string
  /** 1-based line number. */
  line: number
  /** 0-based character offset within the line. */
  column: number
}

export interface SymbolLocationsResult {
  locations: SymbolLocation[]
}
