import { watch, type FSWatcher } from 'fs'
import { basename, join, relative, sep } from 'path'

/**
 * Watch predicate: skip node_modules and noisy .git internals, but keep
 * .git/HEAD, .git/index and .git/refs so commits, staging and branch
 * switches trigger a refresh.
 */
export function shouldIgnore(root: string, path: string): boolean {
  if (path.split(sep).includes('node_modules')) return true

  const gitDir = join(root, '.git')
  if (path === gitDir) return false
  if (path.startsWith(gitDir + sep)) {
    const rel = relative(gitDir, path)
    return !(rel === 'HEAD' || rel === 'index' || rel === 'refs' || rel.startsWith('refs' + sep))
  }

  return false
}

/**
 * Watch a repo and invoke `onEvent(relPath)` for each relevant fs change,
 * where relPath is repo-relative with forward slashes (null when the platform
 * gives no filename). Single native recursive fs.watch handle — no per-dir fds,
 * no EMFILE. Debouncing is left to the caller.
 */
export function watchRepo(root: string, onEvent: (relPath: string | null) => void): FSWatcher {
  const rootName = basename(root)

  const watcher = watch(root, { recursive: true, persistent: true }, (_event, filename) => {
    if (filename === null) return onEvent(null)
    const name = filename.toString()
    if (name === rootName) return // spurious macOS aggregate event
    if (shouldIgnore(root, join(root, name))) return
    onEvent(name.split(sep).join('/'))
  })

  watcher.on('error', () => {})
  return watcher
}
