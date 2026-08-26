export interface PorcelainEntry {
  path: string
  staged: boolean
  modified: boolean
  untracked: boolean
  /** Deleted (in worktree, or staged-delete): excluded from the change list entirely. */
  deleted: boolean
}

/**
 * Parse `git status --porcelain=v2 -z` output. Records are NUL-terminated;
 * rename records (type 2) carry the original path as an extra NUL token.
 * Paths may contain spaces, so fixed-position fields are split off and the
 * remainder rejoined.
 */
export function parsePorcelainV2(nulSeparated: string): PorcelainEntry[] {
  const tokens = nulSeparated.split('\0')
  const entries: PorcelainEntry[] = []

  let i = 0
  while (i < tokens.length) {
    const record = tokens[i++]
    if (!record) continue

    const type = record[0]
    if (type === '?') {
      entries.push({
        path: record.slice(2),
        staged: false,
        modified: false,
        untracked: true,
        deleted: false
      })
      continue
    }
    if (type !== '1' && type !== '2' && type !== 'u') continue // '!' ignored, unknown skipped

    const fields = record.split(' ')
    const xy = fields[1] ?? '..'
    const x = xy[0]
    const y = xy[1]
    // Fixed field counts before the path: type 1 -> 8, type 2 -> 9, u -> 10.
    const pathStart = type === '1' ? 8 : type === '2' ? 9 : 10
    const path = fields.slice(pathStart).join(' ')
    if (type === '2') i++ // consume the origPath token

    if (!path) continue

    if (type === 'u') {
      entries.push({ path, staged: false, modified: true, untracked: false, deleted: false })
      continue
    }

    const deleted = y === 'D' || (x === 'D' && y === '.')
    entries.push({
      path,
      staged: !deleted && x !== '.' && x !== 'D',
      modified: !deleted && y !== '.' && y !== 'D',
      untracked: false,
      deleted
    })
  }

  return entries
}

/**
 * Parse `git diff --name-status -z <base> HEAD` output. Renames/copies use
 * the new path. Deletions are included (since they may be meaningful for
 * custom baselines that diff directly against arbitrary refs).
 */
export function parseNameStatusZ(nulSeparated: string): { path: string }[] {
  const tokens = nulSeparated.split('\0')
  const files: { path: string }[] = []

  let i = 0
  while (i < tokens.length) {
    const status = tokens[i++]
    if (!status) continue
    const kind = status[0]
    if (kind === 'R' || kind === 'C') {
      i++ // old path
      const newPath = tokens[i++]
      if (newPath) files.push({ path: newPath })
    } else {
      const path = tokens[i++]
      if (path) files.push({ path })
    }
  }

  return files
}
