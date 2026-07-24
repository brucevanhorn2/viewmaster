import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { FSWatcher } from 'fs'
import type { BaselineKind, FileContent, HistoryVersion, RepoState } from '@shared/types'
import { runGit } from './git/run'
import { resolveBaseline } from './git/baseline'
import { collectChanges } from './git/changes'
import { readBaseFile, readCurrentFile } from './git/content'
import { watchRepo } from './watcher'
import { addRecentFolder, getRecentFolders } from './store'
import { createRecorder, type Recorder } from './history/recorder'
import { historyPaths } from './history/paths'
import { getObject, readVersions } from './history/store'

const RECOMPUTE_DEBOUNCE_MS = 300

interface Session {
  root: string
  baseline: BaselineKind
  watcher: FSWatcher
  recorder: Recorder | null
}

let session: Session | null = null

async function closeSession(): Promise<void> {
  if (session) {
    await session.watcher.close()
    if (session.recorder) await session.recorder.close()
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

type WindowGetter = () => BrowserWindow | null

async function openRepo(getWindow: WindowGetter, root: string): Promise<RepoState> {
  await closeSession()
  const state = await computeRepoState(root)

  if (state.kind !== 'not-git') addRecentFolder(state.root)

  if (state.kind === 'repo') {
    const watchRoot = state.root
    const recorder = createRecorder(watchRoot, { historyBaseDir: app.getPath('userData') })
    let recomputeTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, (relPath) => {
      recorder.handleEvent(relPath)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const fresh = await computeRepoState(watchRoot)
        if (session?.root !== watchRoot) return // repo switched — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        // Resolve the window at send time — the window that opened the repo
        // may have been closed and replaced since.
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    session = { root: state.root, baseline: state.baseline, watcher, recorder }
  }

  return state
}

export function registerIpc(getWindow: WindowGetter, onRepoOpened?: () => void): void {
  ipcMain.handle('dialog:openFolder', async (): Promise<string | null> => {
    const win = getWindow()
    const options = { properties: ['openDirectory'] as 'openDirectory'[] }
    const result = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle('repo:open', async (_e, root: string): Promise<RepoState> => {
    const state = await openRepo(getWindow, root)
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

  ipcMain.handle('history:list', async (_e, relPath: string): Promise<HistoryVersion[]> => {
    if (!session) return []
    const paths = historyPaths(app.getPath('userData'), session.root)
    return readVersions(paths.logFile(relPath))
  })

  ipcMain.handle('history:read', async (_e, sha: string): Promise<string> => {
    if (!session) return ''
    const paths = historyPaths(app.getPath('userData'), session.root)
    try {
      return await getObject(paths.objectsDir, sha)
    } catch {
      return ''
    }
  })
}

export async function disposeIpc(): Promise<void> {
  await closeSession()
}
