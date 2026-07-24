import { watch, type FSWatcher } from 'fs'
import { basename, join, relative, sep } from 'path'

const DEBOUNCE_MS = 300

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
 * Watch a repo and invoke `onChange` debounced after any relevant fs event.
 *
 * Uses Node's native recursive fs.watch, which on macOS is a single
 * FSEvents-backed handle for the entire tree — unlike a per-directory
 * watcher, it never allocates a file descriptor per subdirectory, so it
 * can't exhaust the process fd limit (EMFILE) on large repos. We filter
 * events through shouldIgnore ourselves since the OS watches everything.
 */
export function watchRepo(root: string, onChange: () => void): FSWatcher {
  let timer: NodeJS.Timeout | null = null
  const schedule = (): void => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, DEBOUNCE_MS)
  }

  // macOS recursive fs.watch emits a spurious aggregate event whose filename
  // is the watched dir's own basename; every real change also arrives as its
  // own path-specific event, so this one is pure noise. Dropping it lets the
  // node_modules/.git filtering actually take effect.
  const rootName = basename(root)

  const watcher = watch(root, { recursive: true, persistent: true }, (_event, filename) => {
    // filename can be null on some platforms/events; when we can't identify
    // the path we can't filter it, so err toward refreshing.
    if (filename === null) return schedule()
    const name = filename.toString()
    if (name === rootName) return
    if (!shouldIgnore(root, join(root, name))) schedule()
  })

  // Without this, a watch error (e.g. the watched dir being removed) rejects
  // unhandled and floods the process. Swallow it: a dead watcher just stops
  // emitting; the next repo:open replaces it.
  watcher.on('error', () => {})

  return watcher
}
