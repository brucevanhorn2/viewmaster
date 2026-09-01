import { execFile } from 'child_process'
import { stat } from 'node:fs/promises'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Spawn the system `git` CLI in `cwd`. Never rejects on a nonzero exit —
 * callers inspect `code`. Rejects only if git itself cannot be spawned, or
 * if `cwd` doesn't exist or can't be accessed.
 *
 * Node's `execFile` reports the exact same ENOENT error code both when the
 * `git` binary can't be found on PATH and when the given `cwd` doesn't
 * exist, so `err.code` alone can't tell those two situations apart. `cwd`
 * here is typically a previously opened folder ("Recent Folder"), which can
 * be deleted, renamed, or unmounted between app sessions — so on that
 * specific ambiguous failure, an extra `stat(cwd)` disambiguates and gives a
 * distinct, accurate rejection (`err.code === 'ENOCWD'`) instead of
 * misreporting it as a missing git installation. `execFile` already reports
 * an inaccessible `cwd` (e.g. `EACCES` from a directory an ancestor path
 * can't be traversed into) as a genuinely distinct error code from `ENOENT`,
 * so that case needs no extra check.
 *
 * The `stat` only runs on this rare `ENOENT` failure path, not on every
 * call — `runGit` is on the hot path of every repo-state recompute, so
 * paying an extra syscall on every single invocation just to cover an edge
 * case would be wasteful.
 */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        const errCode = err ? (err as NodeJS.ErrnoException).code : undefined

        if (errCode === 'ENOENT') {
          stat(cwd).then(
            (stats) => {
              if (stats.isDirectory()) {
                reject(new Error('git CLI not found on PATH'))
              } else {
                const e = new Error(`Folder not found: ${cwd}`) as NodeJS.ErrnoException
                e.code = 'ENOCWD'
                reject(e)
              }
            },
            () => {
              const e = new Error(`Folder not found: ${cwd}`) as NodeJS.ErrnoException
              e.code = 'ENOCWD'
              reject(e)
            }
          )
          return
        }

        if (errCode === 'EACCES') {
          const e = new Error(`Cannot access folder: ${cwd} (${err!.message})`) as NodeJS.ErrnoException
          e.code = 'EACCES'
          reject(e)
          return
        }

        const rawCode = err ? (err as { code?: unknown }).code : 0
        const code = typeof rawCode === 'number' ? rawCode : err ? 1 : 0
        resolve({ code, stdout, stderr })
      }
    )
  })
}
