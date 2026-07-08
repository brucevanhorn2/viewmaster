import { execFile } from 'child_process'

export interface GitResult {
  code: number
  stdout: string
  stderr: string
}

/**
 * Spawn the system `git` CLI in `cwd`. Never rejects on a nonzero exit —
 * callers inspect `code`. Rejects only if git itself cannot be spawned.
 */
export function runGit(cwd: string, args: string[]): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
          reject(new Error('git CLI not found on PATH'))
          return
        }
        const rawCode = err ? (err as { code?: unknown }).code : 0
        const code = typeof rawCode === 'number' ? rawCode : err ? 1 : 0
        resolve({ code, stdout, stderr })
      }
    )
  })
}
