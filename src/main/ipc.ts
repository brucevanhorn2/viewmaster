import { BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { FSWatcher } from 'chokidar'
import type { BaselineKind, FileContent, RepoState } from '@shared/types'
import { runGit } from './git/run'
import { resolveBaseline } from './git/baseline'
import { collectChanges } from './git/changes'
import { readBaseFile, readCurrentFile } from './git/content'
import { watchRepo } from './watcher'
import { addRecentFolder, getRecentFolders } from './store'

interface Session {
  root: string
  baseline: BaselineKind
  watcher: FSWatcher
}

let session: Session | null = null

async function closeSession(): Promise<void> {
  if (session) {
    await session.watcher.close()
    session = null
  }
}

async function computeRepoState(root: string): Promise<RepoState> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    return { kind: 'not-git', root }
  }
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  const repoRoot = toplevel.code === 0 ? toplevel.stdout.trim() : root

  try {
    const baseline = await resolveBaseline(repoRoot)
    const files = await collectChanges(repoRoot, baseline)
    return { kind: 'repo', root: repoRoot, baseline, files }
  } catch (err) {
    return { kind: 'error', root: repoRoot, message: err instanceof Error ? err.message : String(err) }
  }
}

async function openRepo(win: BrowserWindow, root: string): Promise<RepoState> {
  await closeSession()
  const state = await computeRepoState(root)

  if (state.kind !== 'not-git') addRecentFolder(state.root)

  if (state.kind === 'repo') {
    const watchRoot = state.root
    const watcher = watchRepo(watchRoot, async () => {
      const fresh = await computeRepoState(watchRoot)
      if (session?.root === watchRoot && fresh.kind === 'repo') session.baseline = fresh.baseline
      if (!win.isDestroyed()) win.webContents.send('repo:changed', fresh)
    })
    session = { root: state.root, baseline: state.baseline, watcher }
  }

  return state
}

export function registerIpc(win: BrowserWindow, onRepoOpened?: () => void): void {
  ipcMain.handle('dialog:openFolder', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('repo:open', async (_e, root: string): Promise<RepoState> => {
    const state = await openRepo(win, root)
    onRepoOpened?.()
    return state
  })

  ipcMain.handle('repo:refresh', async (): Promise<RepoState | null> => {
    return session ? computeRepoState(session.root) : null
  })

  ipcMain.handle('file:read', (_e, absPath: string): Promise<FileContent> => readCurrentFile(absPath))

  ipcMain.handle('file:readBase', async (_e, relPath: string): Promise<string> => {
    if (!session) return ''
    const { root, baseline } = session
    // In working-only mode diff against HEAD (if any) so staged/modified
    // files still have a meaningful old side; untracked paths yield ''.
    const base = baseline.kind === 'merge-base' ? baseline.base : 'HEAD'
    return readBaseFile(root, base, relPath)
  })

  ipcMain.handle('app:recentFolders', (): string[] => getRecentFolders())

  ipcMain.handle('app:copyPath', (_e, absPath: string): void => {
    clipboard.writeText(absPath)
  })

  ipcMain.handle('app:openExternal', (_e, url: string): void => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })
}

export async function disposeIpc(): Promise<void> {
  await closeSession()
}
