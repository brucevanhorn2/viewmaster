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
import { browseFiles, listFolderTree, toUnchangedFiles } from './files/browse'
import { readResource } from './files/resource'

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

/** The git toplevel for `root`, or null when `root` isn't inside a git work tree. */
interface RootResolution {
  gitRoot: string | null
}

async function resolveRoot(root: string): Promise<RootResolution> {
  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'])
  if (inside.code !== 0 || inside.stdout.trim() !== 'true') return { gitRoot: null }
  const toplevel = await runGit(root, ['rev-parse', '--show-toplevel'])
  return { gitRoot: toplevel.code === 0 ? toplevel.stdout.trim() : root }
}

/**
 * `resolved` lets a caller that already ran resolveRoot (e.g. openRepo, which
 * needs it to look up the persisted mode before this can run) skip a second,
 * identical pair of `rev-parse` calls. Callers that don't have it yet (the
 * watcher's recompute, repo:refresh, mode:set) resolve fresh each time, which
 * also re-detects a folder session that became a git repo since it opened.
 */
async function computeRepoState(
  root: string,
  mode: SidebarMode,
  resolved?: RootResolution
): Promise<RepoState> {
  const { gitRoot } = resolved ?? (await resolveRoot(root))
  if (gitRoot === null) {
    try {
      const paths = await listFolderTree(root)
      return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
    } catch (err) {
      return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    const baseline = await resolveBaseline(gitRoot)
    if (mode === 'changed') {
      const files = await collectChanges(gitRoot, baseline)
      return { kind: 'repo', root: gitRoot, baseline, mode, files }
    }
    const files = await browseFiles(gitRoot, baseline)
    return { kind: 'repo', root: gitRoot, baseline, mode, files }
  } catch (err) {
    return { kind: 'error', root: gitRoot, message: err instanceof Error ? err.message : String(err) }
  }
}

type WindowGetter = () => BrowserWindow | null

async function openRepo(getWindow: WindowGetter, root: string): Promise<RepoState> {
  await closeSession()
  const resolved = await resolveRoot(root)
  const mode = getFolderMode(resolved.gitRoot ?? root)
  const state = await computeRepoState(root, mode, resolved)

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
        if (session?.root !== watchRoot || session.mode !== currentMode) return // repo switched or mode toggled — drop stale update
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
      // A folder session has no Changed/Browse toggle — it always shows the
      // full tree — so `mode` is unused for 'folder' sessions; 'browse' is
      // semantically accurate (as opposed to the never-read-for-anything
      // 'changed' default), but only 'repo' sessions actually consult it.
      mode: state.kind === 'repo' ? state.mode : 'browse',
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
    const root = session.root
    session.mode = mode
    setFolderMode(root, mode)
    const fresh = await computeRepoState(root, mode)
    if (session?.root !== root || session.mode !== mode) return null // repo switched or mode changed again mid-compute — drop stale update
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

  ipcMain.handle('file:readResource', (_e, absPath: string): Promise<{ base64: string; mime: string } | null> => {
    if (!session) return Promise.resolve(null)
    return readResource(absPath, session.root)
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
