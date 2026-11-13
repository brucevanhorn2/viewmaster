import { app, BrowserWindow, clipboard, dialog, ipcMain, shell } from 'electron'
import type { FSWatcher } from 'fs'
import { realpath } from 'fs/promises'
import { join, relative } from 'path'
import type {
  BaselineKind,
  ExternalKind,
  FileContent,
  HistoryVersion,
  RepoState,
  SearchResult,
  SidebarMode,
  SymbolLocation,
  SymbolLocationsResult,
  SymbolQuery
} from '@shared/types'
import { runGit } from './git/run'
import { resolveBaseline } from './git/baseline'
import { collectChanges } from './git/changes'
import { readBaseFile, readCurrentFile } from './git/content'
import { watchRepo } from './watcher'
import { addRecentFolder, getFolderMode, getRecentFolders, setFolderMode } from './store'
import { createRecorder, type Recorder } from './history/recorder'
import { historyPaths } from './history/paths'
import { getObject, readVersions } from './history/store'
import { browseFiles, listFolderTree, listGitTree, toUnchangedFiles } from './files/browse'
import { readResource, resolveWithinRoot } from './files/resource'
import { searchFiles } from './search/scan'
import { looksLikeDefinition } from './search/definitionHeuristics'
import { looksLikeImportOf } from './search/importHeuristics'
import { resolveExternal } from './files/externalRoots'
import { createLspManager, type LspManager } from './lsp/manager'
import { languageForPath } from './lsp/translate'

const RECOMPUTE_DEBOUNCE_MS = 300
// Changed files are forwarded to running language servers in batches.
const LSP_NOTIFY_BATCH_MS = 200

interface Session {
  root: string
  baseline: BaselineKind | null
  mode: SidebarMode
  watcher: FSWatcher
  recorder: Recorder | null
  searchPaths: string[] | null
  // Bumped every time searchPaths is invalidated. A cache-populating listing
  // in flight when an invalidation happens must not resurrect the cache with
  // pre-change data once it resolves — comparing the generation it started
  // with against the current one detects that race (see search:query).
  searchGeneration: number
  // Session-only override for the "changed files" baseline (issue #13) --
  // never persisted, always reset to auto-detection when a fresh session is
  // created (openRepo). null means "use resolveBaseline() as normal."
  customBaselineRef: string | null
  // Go/Python language servers for this folder (issue #22). Starts nothing
  // until the first query; disposed with the session.
  lsp: Pick<LspManager, 'query' | 'externalRoots' | 'dispose' | 'notifyFilesChanged'>
}

let session: Session | null = null
let currentSearchController: AbortController | null = null
let currentDefinitionsController: AbortController | null = null
let currentReferencesController: AbortController | null = null
let currentImportedByController: AbortController | null = null
let currentRelatedReferencesController: AbortController | null = null
// Language-server shutdowns started by closeSession() and not yet finished.
const pendingLspDisposals = new Set<Promise<void>>()

/**
 * Returns the session's cached file listing, populating it if this is the
 * first search since the last invalidation. Guards against a slow,
 * now-superseded listing overwriting a fresher invalidation — see
 * `searchGeneration` on `Session`. Shared by `search:query` and the
 * `symbol:definitions`/`symbol:references` handlers below, which all
 * search the same underlying listing.
 */
async function getSearchPaths(activeSession: Session): Promise<string[]> {
  if (activeSession.searchPaths !== null) return activeSession.searchPaths
  const generation = activeSession.searchGeneration
  const paths = activeSession.baseline
    ? await listGitTree(activeSession.root)
    : await listFolderTree(activeSession.root)
  if (activeSession.searchGeneration === generation) {
    activeSession.searchPaths = paths
  }
  return paths
}

async function closeSession(): Promise<void> {
  currentSearchController?.abort()
  currentSearchController = null
  currentDefinitionsController?.abort()
  currentDefinitionsController = null
  currentReferencesController?.abort()
  currentReferencesController = null
  currentImportedByController?.abort()
  currentImportedByController = null
  currentRelatedReferencesController?.abort()
  currentRelatedReferencesController = null
  if (session) {
    // Detach first and dispose the manager before any await, so an LSP query
    // still in flight sees its session is no longer current (and resolves
    // to a fallback) instead of a half-closed session that still looks live.
    // The shutdown itself is not awaited here (a server mid-load can take
    // seconds to exit); disposeIpc() awaits every pending one at quit.
    const closing = session
    session = null
    const lspDisposed = closing.lsp.dispose().catch(() => {})
    pendingLspDisposals.add(lspDisposed)
    void lspDisposed.finally(() => pendingLspDisposals.delete(lspDisposed))
    try {
      await closing.watcher.close()
    } finally {
      if (closing.recorder) await closing.recorder.close()
    }
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
  let gitRoot: string | null
  try {
    ;({ gitRoot } = resolved ?? (await resolveRoot(root)))
  } catch (err) {
    return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
  }
  if (gitRoot === null) {
    try {
      const paths = await listFolderTree(root)
      return { kind: 'folder', root, files: toUnchangedFiles(root, paths) }
    } catch (err) {
      return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
    }
  }

  try {
    const customRef = session?.customBaselineRef
    const baseline: BaselineKind = customRef ? { kind: 'custom', ref: customRef } : await resolveBaseline(gitRoot)
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

// Bumped at the start of every openRepo call. Guards against overlapping
// repo:open calls (e.g. rapid folder switching): whichever call's watcher/
// recorder would otherwise be assigned into `session` last "wins" even if
// it's not the most recent call, orphaning the loser's watcher/recorder
// forever. Each call captures the generation it started with and checks it
// again just before committing to `session` -- see `isStaleGeneration`.
let openGeneration = 0

/**
 * True when a call that began at generation `myGeneration` has been
 * superseded by a newer `openRepo` call (which bumped `currentGeneration`
 * past it) by the time it's ready to commit its result.
 */
export function isStaleGeneration(myGeneration: number, currentGeneration: number): boolean {
  return myGeneration !== currentGeneration
}

export async function openRepo(getWindow: WindowGetter, root: string): Promise<RepoState> {
  const myGeneration = ++openGeneration
  await closeSession()
  let resolved: RootResolution
  try {
    resolved = await resolveRoot(root)
  } catch (err) {
    return { kind: 'error', root, message: err instanceof Error ? err.message : String(err) }
  }
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
    // The session this watcher belongs to; set once this call wins the race.
    let owner: Session | null = null
    const lspChanged = new Set<string>()
    let lspTimer: NodeJS.Timeout | null = null
    const watcher = watchRepo(watchRoot, (relPath) => {
      recorder?.handleEvent(relPath)
      // Tell running language servers what changed on disk (a pull, codegen),
      // so answers that read other files are not computed from stale content.
      if (relPath && relPath !== '.git' && !relPath.startsWith('.git/')) {
        lspChanged.add(join(watchRoot, relPath))
        lspTimer ??= setTimeout(() => {
          lspTimer = null
          const paths = [...lspChanged]
          lspChanged.clear()
          if (owner && session === owner) owner.lsp.notifyFilesChanged(paths)
        }, LSP_NOTIFY_BATCH_MS)
      }
      if (recomputeTimer) clearTimeout(recomputeTimer)
      recomputeTimer = setTimeout(async () => {
        const currentMode = session?.mode ?? 'changed'
        const fresh = await computeRepoState(watchRoot, currentMode)
        if (session?.root !== watchRoot || session.mode !== currentMode) return // repo switched or mode toggled — drop stale update
        if (fresh.kind === 'repo') session.baseline = fresh.baseline
        session.searchPaths = null
        session.searchGeneration++
        // Resolve the window at send time — the window that opened the repo
        // may have been closed and replaced since.
        const win = getWindow()
        if (win && !win.isDestroyed()) win.webContents.send('repo:changed', fresh)
      }, RECOMPUTE_DEBOUNCE_MS)
    })
    if (isStaleGeneration(myGeneration, openGeneration)) {
      // A newer openRepo call started after this one -- this call lost the
      // race. Don't leak the watcher/recorder just constructed for it, and
      // don't let it clobber the newer call's session.
      await watcher.close()
      if (recorder) await recorder.close()
    } else {
      session = {
        root: state.root,
        baseline: state.kind === 'repo' ? state.baseline : null,
        // A folder session has no Changed/Browse toggle — it always shows the
        // full tree — so `mode` is unused for 'folder' sessions; 'browse' is
        // semantically accurate (as opposed to the never-read-for-anything
        // 'changed' default), but only 'repo' sessions actually consult it.
        mode: state.kind === 'repo' ? state.mode : 'browse',
        watcher,
        recorder,
        searchPaths: null,
        searchGeneration: 0,
        customBaselineRef: null,
        // Created only for the winning call; it spawns nothing until queried.
        lsp: createLspManager(state.root)
      }
      owner = session
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
    const customRef = session.customBaselineRef
    session.mode = mode
    setFolderMode(root, mode)
    const fresh = await computeRepoState(root, mode)
    // Stale if the repo switched, the mode changed again, or a concurrent
    // baseline:setCustom call already changed customBaselineRef mid-compute
    // -- `fresh` reflects whatever ref was active when computeRepoState
    // read it, so committing it here would stomp that newer call's result.
    if (session?.root !== root || session.mode !== mode || session.customBaselineRef !== customRef) return null
    if (fresh.kind === 'repo') session.baseline = fresh.baseline
    return fresh
  })

  ipcMain.handle('baseline:setCustom', async (_e, ref: string | null): Promise<RepoState | null> => {
    if (!session) return null
    const activeSession = session
    const root = activeSession.root
    const mode = activeSession.mode
    const prev = activeSession.customBaselineRef
    activeSession.customBaselineRef = ref
    const fresh = await computeRepoState(root, mode)
    // Stale if the repo switched, the mode changed, or a later call to this
    // same handler (a different ref) already changed customBaselineRef out
    // from under this one mid-compute -- checked against `ref`, the value
    // this call itself set, before either rolling back or committing below,
    // so a stale response never undoes a newer call's still-in-progress or
    // already-applied change.
    const stillOurs = session === activeSession && session.mode === mode && session.customBaselineRef === ref
    if (!stillOurs) return null
    // Roll back a bad ref so it doesn't stick forever with no in-app way to
    // clear it (the Sidebar hides the reset control on error states).
    if (fresh.kind !== 'repo') {
      session.customBaselineRef = prev
      return fresh
    }
    session.baseline = fresh.baseline
    return fresh
  })

  ipcMain.handle('git:listRefs', async (): Promise<string[]> => {
    if (!session) return []
    const [branches, tags] = await Promise.all([
      runGit(session.root, ['branch', '-a', '--format=%(refname:short)']),
      runGit(session.root, ['tag'])
    ])
    const branchNames =
      branches.code === 0
        ? branches.stdout
            .split('\n')
            .map((line) => line.trim())
            .filter((line) => line !== '' && line !== 'origin/HEAD')
        : []
    const tagNames = tags.code === 0 ? tags.stdout.split('\n').map((line) => line.trim()).filter(Boolean) : []
    return [...new Set([...branchNames, ...tagNames])]
  })

  ipcMain.handle('file:read', async (_e, absPath: string): Promise<FileContent> => {
    // Captured once: closeSession() may null `session` across the awaits.
    const activeSession = session
    if (!activeSession) return { kind: 'missing' }
    const real =
      (await resolveWithinRoot(absPath, activeSession.root)) ??
      (await resolveExternal(absPath, activeSession.lsp.externalRoots()))?.real
    if (!real) return { kind: 'missing' }
    return readCurrentFile(real)
  })

  ipcMain.handle('file:externalKind', async (_e, absPath: string): Promise<ExternalKind | null> => {
    const activeSession = session
    if (!activeSession || typeof absPath !== 'string') return null
    if (await resolveWithinRoot(absPath, activeSession.root)) return null
    return (await resolveExternal(absPath, activeSession.lsp.externalRoots()))?.kind ?? null
  })

  ipcMain.handle('file:readBase', async (_e, relPath: string): Promise<string> => {
    if (!session || !session.baseline) return ''
    const { root, baseline } = session
    // In working-only mode diff against HEAD (if any) so staged/modified
    // files still have a meaningful old side; untracked paths yield ''.
    const base = baseline.kind === 'merge-base' ? baseline.base : baseline.kind === 'custom' ? baseline.ref : 'HEAD'
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

  ipcMain.handle('app:showInFolder', (_e, absPath: string): void => {
    shell.showItemInFolder(absPath)
  })

  ipcMain.handle('app:openExternal', (_e, url: string): void => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
  })

  ipcMain.handle('app:openInBrowser', async (_e, absPath: string): Promise<void> => {
    if (!session) return
    const real = await resolveWithinRoot(absPath, session.root)
    if (!real) return
    void shell.openPath(real)
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

  ipcMain.handle('search:query', async (_e, query: string): Promise<SearchResult> => {
    currentSearchController?.abort()
    const activeSession = session
    if (!activeSession) return { matches: [], truncated: false }
    const controller = new AbortController()
    currentSearchController = controller
    const startedAt = Date.now()
    try {
      const paths = await getSearchPaths(activeSession)
      return await searchFiles(activeSession.root, paths, query, {
        signal: controller.signal,
        startedAt
      })
    } catch (err) {
      return { matches: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
    }
  })

  ipcMain.handle(
    'symbol:definitions',
    async (_e, q: SymbolQuery): Promise<SymbolLocationsResult> => {
      currentDefinitionsController?.abort()
      const activeSession = session
      if (!activeSession || !isSymbolQuery(q)) return { locations: [], truncated: false }
      // Registered before awaiting the server, so "latest query wins" holds
      // across the LSP wait too.
      const controller = new AbortController()
      currentDefinitionsController = controller
      return lspFirst('definition', activeSession, q, controller.signal, heuristicDefinitions)
    }
  )

  ipcMain.handle(
    'symbol:references',
    async (_e, q: SymbolQuery): Promise<SymbolLocationsResult> => {
      currentReferencesController?.abort()
      const activeSession = session
      if (!activeSession || !isSymbolQuery(q)) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentReferencesController = controller
      return lspFirst('references', activeSession, q, controller.signal, heuristicReferences)
    }
  )

  ipcMain.handle(
    'related:importedBy',
    async (_e, basename: string): Promise<SymbolLocationsResult> => {
      currentImportedByController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentImportedByController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches, truncated } = await searchFiles(activeSession.root, paths, basename, {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          lineFilter: (line) => looksLikeImportOf(line, basename)
        })
        const seen = new Set<string>()
        const locations: SymbolLocation[] = []
        for (const m of matches) {
          const key = `${m.absPath}:${m.line}`
          if (seen.has(key)) continue
          seen.add(key)
          locations.push({ path: m.path, absPath: m.absPath, line: m.line, column: m.column })
        }
        return { locations, truncated }
      } catch (err) {
        return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  ipcMain.handle(
    'related:references',
    async (_e, names: string[]): Promise<SymbolLocationsResult> => {
      currentRelatedReferencesController?.abort()
      const activeSession = session
      if (!activeSession) return { locations: [], truncated: false }
      if (names.length === 0) return { locations: [], truncated: false }
      const controller = new AbortController()
      currentRelatedReferencesController = controller
      const startedAt = Date.now()
      try {
        const paths = await getSearchPaths(activeSession)
        const { matches, truncated } = await searchFiles(activeSession.root, paths, names[0], {
          signal: controller.signal,
          startedAt,
          mode: 'word',
          caseSensitive: true,
          words: names
        })
        const locations: SymbolLocation[] = matches.map((m) => ({
          path: m.path,
          absPath: m.absPath,
          line: m.line,
          column: m.column
        }))
        return { locations, truncated }
      } catch (err) {
        return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )
}

type Heuristic = (s: Session, word: string, signal: AbortSignal) => Promise<SymbolLocationsResult>

function isSymbolQuery(q: unknown): q is SymbolQuery {
  if (!q || typeof q !== 'object') return false
  const o = q as Record<string, unknown>
  return (
    typeof o.word === 'string' &&
    typeof o.absPath === 'string' &&
    typeof o.line === 'number' &&
    typeof o.column === 'number'
  )
}

/**
 * The path to hand the language server for a renderer-supplied document, or
 * null when it is neither in-root nor under a main-computed external root
 * (only files the user can open reach the server). An in-root file is
 * expressed under the root *as opened* -- the same root the server's rootUri
 * and the location translation use -- so a root reached through a junction,
 * symlink, subst/mapped drive or a lowercase drive still matches. External
 * files keep their realpath, which is what the allow-list roots hold.
 */
async function serverDocumentPath(absPath: string, s: Session): Promise<string | null> {
  const inRoot = await resolveWithinRoot(absPath, s.root)
  if (inRoot) {
    try {
      return join(s.root, relative(await realpath(s.root), inRoot))
    } catch {
      return null
    }
  }
  return (await resolveExternal(absPath, s.lsp.externalRoots()))?.real ?? null
}

/**
 * Go/Python ask the session's language server first; a real answer (even an
 * empty one) replaces the heuristic. Any fallback runs the word heuristic and
 * labels it approximate. Other languages are heuristic-only, unlabelled.
 */
async function lspFirst(
  kind: 'definition' | 'references',
  activeSession: Session,
  q: SymbolQuery,
  signal: AbortSignal,
  heuristic: Heuristic
): Promise<SymbolLocationsResult> {
  const language = languageForPath(q.absPath)
  if (!language) return { ...(await heuristic(activeSession, q.word, signal)), source: 'heuristic' }
  const docPath = await serverDocumentPath(q.absPath, activeSession)
  const answer = docPath
    ? await activeSession.lsp.query(kind, { ...q, absPath: docPath })
    : ({ kind: 'fallback', reason: 'unavailable' } as const)
  // The folder may have switched while the server worked: never hand the old
  // session's locations (or the old word's matches) to the new one.
  if (session !== activeSession) return { locations: [], truncated: false }
  if (answer.kind === 'answer') return { locations: answer.locations, truncated: false, source: 'lsp' }
  // Superseded by a newer query while the server worked: nobody is waiting for a fallback,
  // so don't scan, and don't produce an "approximate" notice for it.
  if (signal.aborted) return { locations: [], truncated: false }
  return {
    ...(await heuristic(activeSession, q.word, signal)),
    source: 'heuristic',
    approximate: { language, reason: answer.reason }
  }
}

/** Today's word heuristic for definitions (declaration-shaped lines, one per line). */
async function heuristicDefinitions(
  activeSession: Session,
  word: string,
  signal: AbortSignal
): Promise<SymbolLocationsResult> {
  const startedAt = Date.now()
  try {
    const paths = await getSearchPaths(activeSession)
    const { matches, truncated } = await searchFiles(activeSession.root, paths, word, {
      signal,
      startedAt,
      mode: 'word',
      caseSensitive: true,
      lineFilter: (line) => looksLikeDefinition(line, word)
    })
    const seen = new Set<string>()
    const locations: SymbolLocation[] = []
    for (const m of matches) {
      const key = `${m.absPath}:${m.line}`
      if (seen.has(key)) continue
      seen.add(key)
      locations.push({ path: m.path, absPath: m.absPath, line: m.line, column: m.column })
    }
    return { locations, truncated }
  } catch (err) {
    return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Today's word heuristic for references (every whole-word match). */
async function heuristicReferences(
  activeSession: Session,
  word: string,
  signal: AbortSignal
): Promise<SymbolLocationsResult> {
  const startedAt = Date.now()
  try {
    const paths = await getSearchPaths(activeSession)
    const { matches, truncated } = await searchFiles(activeSession.root, paths, word, {
      signal,
      startedAt,
      mode: 'word',
      caseSensitive: true
    })
    const locations: SymbolLocation[] = matches.map((m) => ({
      path: m.path,
      absPath: m.absPath,
      line: m.line,
      column: m.column
    }))
    return { locations, truncated }
  } catch (err) {
    return { locations: [], truncated: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/** Upper bound on how long disposeIpc waits for language servers to exit. */
export const DISPOSE_BOUND_MS = 5000

export async function disposeIpc(boundMs: number = DISPOSE_BOUND_MS): Promise<void> {
  try {
    await closeSession()
  } finally {
    // No orphaned language servers: wait for every shutdown, including ones
    // started by earlier folder switches — but never forever, so quit (and
    // window-all-closed) always completes. Each client already escalates to
    // SIGKILL; this only guards against a wait that never settles.
    let timer: NodeJS.Timeout | undefined
    await Promise.race([
      Promise.all([...pendingLspDisposals]),
      new Promise<void>((r) => (timer = setTimeout(r, boundMs)))
    ])
    clearTimeout(timer)
  }
}
