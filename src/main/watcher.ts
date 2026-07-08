import { watch, type FSWatcher } from 'chokidar'
import { join, relative, sep } from 'path'

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

/** Watch a repo and invoke `onChange` debounced after any relevant fs event. */
export function watchRepo(root: string, onChange: () => void): FSWatcher {
  const watcher = watch(root, {
    ignoreInitial: true,
    ignored: (path: string) => shouldIgnore(root, path)
  })

  let timer: NodeJS.Timeout | null = null
  watcher.on('all', () => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(onChange, DEBOUNCE_MS)
  })

  return watcher
}
