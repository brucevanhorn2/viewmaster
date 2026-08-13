import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { FSWatcher } from 'fs'
import type { BaselineKind, FileContent, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
import { runGit } from './git/run'
import { resolveBaseline } from './git/baseline'
import { collectChanges } from './git/changes'
import { readBaseFile, readCurrentFile } from './git/content'
import { watchRepo } from './watcher'
import { addRecentFolder, getFolderMode, getRecentFolders, setFolderMode } from './store'
import { createRecorder, type Recorder } from './history/recorder'
import { historyPaths } from './history/paths'
import { getObject, readVersions } from './history/store'
import { listFolderTree, listGitTree, overlayStatus, toUnchangedFiles } from './files/browse'

const RECOMPUTE_DEBOUNCE_MS = 300

interface Session {
  root: string
  baseline: BaselineKind | null
  mode: SidebarMode
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

async function computeRepoState(root: string, mode: SidebarMode): Promise<RepoState> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') {
    try {
      const paths = await listFolderTree(root)
      return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
    } catch (err) {
      return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
    }
  }
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  const repoRoot = toplevel.code === 0 ? toplevel.stdout.trim() : root

  try {
    const baseline = await resolveBaseline(repoRoot)
    if (mode === 'changed') {
      const files = await collectChanges(repoRoot, baseline)
      return { kind: 'repo', root: repoRoot, baseline, mode, files }
    }
    const [allPaths, changed] = await Promise.all([
      listGitTree(repoRoot),
      collectChanges(repoRoot, baseline)
    ])
    return { kind: 'repo', root: repoRoot, baseline, mode, files: overlayStatus(repoRoot, allPaths, changed) }
  } catch (err) {
    return { kind: 'error', root: repoRoot, message: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * Resolve the key used for persisted per-folder mode: the git toplevel for a
 * repo, the raw path otherwise. A second, cheap `rev-parse` call — kept
 * separate from computeRepoState so mode can be looked up before the first
 * real computation runs.
 */
async function resolveModeKey(root: string): Promise<string> {
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  return toplevel.code === 0 ? toplevel.stdout.trim() : root
}

type WindowGetter = () => BrowserWindow | null

async function openRepo(getWindow: WindowGetter, root: string): Promise<RepoState> {
  await closeSession()
  const mode = getFolderMode(await resolveModeKey(root))
  const state = await computeRepoState(root, mode)

  if (state.kind !== 'error') addRecentFolder(state.root)

  if (state.kind === 'repo' || state.kind === 'folder') {
    const watchRoot = state.root
    const recorder =
      state.kind === 'repo'
        ? createRecorder(watchRoot, {
            historyBaseDir: app.getPath('userData'),
            onCapture: (relPath) => {
              const win = getWindow()
              if (win && !win.isDestroyed()) win.webContents.send('history:changed', relPath)
            }
          })
        : null
    let recomputeTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, (relPath) => {
      recorder?.handleEvent(relPath)
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const currentMode = session?.mode ?? 'changed'
        const fresh = await computeRepoState(watchRoot, currentMode)
        if (session?.root !== watchRoot) return // repo switched — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        // Resolve the window at send time — the window that opened the repo
        // may have been closed and replaced since.
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    session = {
      root: state.root,
      baseline: state.kind === 'repo' ? state.baseline : null,
      mode: state.kind === 'repo' ? state.mode : 'changed',
      watcher,
      recorder
    }
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
    return session ? computeRepoState(session.root, session.mode) : null
  })

  ipcMain.handle('mode:set', async (_e, mode: SidebarMode): Promise<RepoState | null> => {
    if (!session) return null
    session.mode = mode
    setFolderMode(session.root, mode)
    const fresh = await computeRepoState(session.root, mode)
    if (fresh.kind === 'repo') session.baseline = fresh.baseline
    return fresh
  })

  ipcMain.handle('file:read', (_e, absPath: string): Promise<FileContent> => readCurrentFile(absPath))

  ipcMain.handle('file:readBase', async (_e, relPath: string): Promise<string> => {
    if (!session || !session.baseline) return ''
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
