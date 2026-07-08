import type { BaselineKind } from '@shared/types'
import { runGit } from './run'

/**
 * Default-branch detection, per spec:
 * origin/HEAD -> local main/master -> init.defaultBranch.
 */
export async function detectDefaultBranch(cwd: string): Promise<string | null> {
  const sym = await runGit(cwd, ['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'])
  if (sym.code === 0) {
    const match = sym.stdout.trim().match(/^refs\/remotes\/origin\/(.+)$/)
    if (match) return match[1]
  }

  for (const name of ['main', 'master']) {
    const ref = await runGit(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${name}`])
    if (ref.code === 0) return name
  }

  const cfg = await runGit(cwd, ['config', '--get', 'init.defaultBranch'])
  const configured = cfg.stdout.trim()
  if (cfg.code === 0 && configured) return configured

  return null
}

/**
 * Baseline = merge-base of HEAD and the default branch (the branch's fork
 * point). Every edge case degrades to working-tree-only mode.
 */
export async function resolveBaseline(cwd: string): Promise<BaselineKind> {
  const head = await runGit(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'])
  if (head.code !== 0) return { kind: 'working-only', reason: 'no-commits' }

  const branchRes = await runGit(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
  if (branchRes.code !== 0) return { kind: 'working-only', reason: 'detached' }
  const branch = branchRes.stdout.trim()

  const defaultBranch = await detectDefaultBranch(cwd)
  if (!defaultBranch) return { kind: 'working-only', reason: 'no-baseline', branch }
  if (branch === defaultBranch) return { kind: 'working-only', reason: 'on-default', branch }

  // Prefer the remote-tracking ref (what the branch will merge into), fall
  // back to the local branch; if neither exists the baseline is unresolvable.
  let defaultRef: string | null = null
  for (const candidate of [`refs/remotes/origin/${defaultBranch}`, `refs/heads/${defaultBranch}`]) {
    const res = await runGit(cwd, ['rev-parse', '--verify', '--quiet', candidate])
    if (res.code === 0) {
      defaultRef = candidate
      break
    }
  }
  if (!defaultRef) return { kind: 'working-only', reason: 'no-baseline', branch }

  const mergeBase = await runGit(cwd, ['merge-base', 'HEAD', defaultRef])
  if (mergeBase.code !== 0) return { kind: 'working-only', reason: 'no-baseline', branch }

  return { kind: 'merge-base', base: mergeBase.stdout.trim(), defaultBranch, branch }
}
