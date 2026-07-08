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
  const root = await mkdtemp(join(tmpdir(), 'viewmaster-repo-'))
  const git = (...args: string[]): Promise<GitResult> => runGit(root, args)

  await git('init', '-b', 'main')
  await git('config', 'user.name', 'Test User')
  await git('config', 'user.email', 'test@example.com')
  await git('config', 'commit.gpgsign', 'false')

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
