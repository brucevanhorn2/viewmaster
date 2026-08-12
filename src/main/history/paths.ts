import { createHash } from 'crypto'
import { join } from 'path'

export function repoId(root: string): string {
  return createHash('sha256').update(root).digest('hex').slice(0, 16)
}

export function pathHash(relPath: string): string {
  return createHash('sha256').update(relPath).digest('hex')
}

export interface HistoryPaths {
  repoDir: string
  objectsDir: string
  logsDir: string
  stateFile: string
  logFile(relPath: string): string
}

/** Directory layout for one repo's history. `baseDir` is Electron's userData dir. */
export function historyPaths(baseDir: string, root: string): HistoryPaths {
  const repoDir = join(baseDir, 'history', repoId(root))
  const logsDir = join(repoDir, 'logs')
  return {
    repoDir,
    objectsDir: join(repoDir, 'objects'),
    logsDir,
    stateFile: join(repoDir, 'state.json'),
    logFile: (relPath: string) => join(logsDir, `${pathHash(relPath)}.jsonl`)
  }
}
