import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { runGit, type GitResult } from './run'

export interface TestRepo {
  root: string
  git: (...args: string[]) => Promise<GitResult>
  write: (rel: string, content: string | Buffer) => Promise<void>
  cleanup: () => Promise<void>
}

/** Create a throwaway git repo in a temp dir (default branch: main). Test-only. */
export async function makeRepo(): Promise<TestRepo> {
  const root = await mkdtemp(join(tmpdir(), 'secondlook-repo-'))
  const git = (...args: string[]): Promise<GitResult> => runGit(root, args)
  // runGit never rejects on a nonzero exit; a broken fixture repo must fail here, not later.
  const setup = async (...args: string[]): Promise<void> => {
    const res = await git(...args)
    if (res.code !== 0) throw new Error(`git ${args.join(' ')} failed (${res.code}): ${res.stderr}`)
  }

  await setup('init', '-b', 'main')
  await setup('config', 'user.name', 'Test User')
  await setup('config', 'user.email', 'test@example.com')
  await setup('config', 'commit.gpgsign', 'false')

  return {
    root,
    git,
    write: async (rel, content) => {
      const abs = join(root, rel)
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, content)
    },
    cleanup: () => rm(root, { recursive: true, force: true })
  }
}
