import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import * as monaco from 'monaco-editor'
import type { ChangedFile, HistoryVersion, RepoState, SearchMatch, SidebarMode } from '@shared/types'
import Sidebar from './components/Sidebar'
import ContentPane from './components/ContentPane'
import HistoryPane from './components/HistoryPane'
import SearchPane from './components/SearchPane'
import RelatedFilesPane from './components/RelatedFilesPane'
import {
  defaultSelection,
  singleClickSelection,
  type RevisionRef,
  type Selection
} from './history/selection'
import {
  canGoBack,
  canGoForward,
  currentEntry,
  goBack,
  goForward,
  initialNavigationState,
  pushEntry,
  type NavigationTarget
} from './navigation/history'
import { isStaleRequest } from './navigation/staleRequest'
import { absPathOfModelUri, relativeToRoot, sameFsPath } from './code/monacoPath'
import StatusNotice from './components/StatusNotice'
import { SIDEBAR_SHORTCUT } from './shortcuts'

function Welcome({ onOpen }: { onOpen: (root: string) => void }): React.JSX.Element {
  const [recents, setRecents] = useState<string[]>([])

  useEffect(() => {
    void window.viewmaster.recentFolders().then(setRecents)
  }, [])

  const pick = async (): Promise<void> => {
    const root = await window.viewmaster.openFolderDialog()
    if (root) onOpen(root)
  }

  return (
    <div className="welcome">
      <h1>View Master</h1>
      <p>Read-only viewer for markdown documents and branch diffs.</p>
      <div className="welcome-mark" aria-hidden="true" />
      <button className="open-button" onClick={() => void pick()}>
        Open Folder…
      </button>
      {recents.length > 0 && (
        <div className="recent-list">
          <div className="recent-title">Recent</div>
          {recents.map((root) => (
            <div key={root} className="recent-item" onClick={() => onOpen(root)}>
              {root}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export default function App(): React.JSX.Element {
  const [repo, setRepo] = useState<RepoState | null>(null)
  const [navState, setNavState] = useState(initialNavigationState())
  const [refreshKey, setRefreshKey] = useState(0)
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [selection, setSelection] = useState<Selection>(defaultSelection())
  const [historyTick, setHistoryTick] = useState(0)

  // Guards openFolder/openFile against resolving out of order: two
  // window.viewmaster.openRepo() calls racing (e.g. two Recent Folder
  // clicks, or a menu:openFile racing a folder open) can resolve in either
  // order regardless of which one actually became the live main-process
  // session (see isStaleGeneration in src/main/ipc.ts for that separate,
  // main-process-side race) -- applying a response whose request has since
  // been superseded would show one repo's data while session/file:read
  // containment is actually keyed to a different, newer root. Bumped
  // synchronously before each call's first await, so the outcome is
  // deterministic regardless of which call's IPC round-trip finishes first.
  const openRequestId = useRef(0)

  const [sidebarVisible, setSidebarVisibleState] = useState(true)
  const sidebarVisibleRef = useRef(true)
  // Where focus was inside the sidebar when it was hidden, so showing it puts focus back
  // (hiding makes the pane inert, which drops focus to <body>).
  const sidebarFocus = useRef<HTMLElement | null>(null)
  const setSidebarVisible = useCallback((visible: boolean): void => {
    if (!visible && sidebarVisibleRef.current) {
      const el = document.activeElement
      sidebarFocus.current = el instanceof HTMLElement && el.closest('.sidebar-pane') ? el : null
    }
    sidebarVisibleRef.current = visible
    setSidebarVisibleState(visible)
  }, [])
  // Bumped on every Find in Files request so SearchPane refocuses its input even when
  // it was already open (e.g. open, hide the sidebar, Find in Files again).
  const [searchFocusRequest, setSearchFocusRequest] = useState(0)

  const openFolder = useCallback((root: string): void => {
    // Nothing from the previous folder is relevant to the new one -- a
    // complete reset (even when reopening the same folder from Recents) is
    // simplest and correct. See docs/superpowers/specs/2026-08-26-monaco-
    // model-disposal-design.md. Skip a model still attached to a live
    // editor (same guard as modelLru.ts's eviction path) -- the old
    // CodeView is still rendering against it until this folder's state
    // finishes loading and it unmounts; disposing it now would blank that
    // pane mid-transition. It stays tracked and gets swept up by the next
    // LRU eviction cycle once it's no longer attached.
    monaco.editor
      .getModels()
      .filter((model) => !model.isAttachedToEditor())
      .forEach((model) => model.dispose())
    const myRequestId = ++openRequestId.current
    void window.viewmaster.openRepo(root).then((state) => {
      if (isStaleRequest(myRequestId, openRequestId.current)) return
      setRepo(state)
      setSidebarVisible(true)
      setNavState(initialNavigationState())
    })
  }, [])

  const openFile = useCallback((payload: { root: string; absPath: string }): void => {
    // pickFile is the only real sender and always includes both fields --
    // this guard only matters for a malformed/payload-less menu:openFile
    // message (e.g. a manual send-ipc call during testing), turning what
    // would otherwise be an uncaught TypeError into a silent no-op.
    if (!payload?.root || !payload.absPath) return
    const myRequestId = ++openRequestId.current
    void window.viewmaster.openRepo(payload.root).then((state) => {
      if (isStaleRequest(myRequestId, openRequestId.current)) return
      setRepo(state)
      setSidebarVisible(true)
      setNavState(pushEntry(initialNavigationState(), { absPath: payload.absPath }))
    })
  }, [])

  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])

  const setCustomBaseline = useCallback((ref: string | null): void => {
    void window.viewmaster.setCustomBaseline(ref).then((state) => {
      if (!state) return
      setRepo(state)
    })
  }, [])

  useEffect(() => window.viewmaster.onMenuOpenFolder(openFolder), [openFolder])
  useEffect(() => window.viewmaster.onMenuOpenFile(openFile), [openFile])

  // Watcher-driven auto-refresh: update the change list in place. `selected`
  // is re-derived below from the nav stack + fresh `repo`, so no separate
  // reconciliation is needed here.
  useEffect(
    () =>
      window.viewmaster.onRepoChanged((state) => {
        setRepo(state)
        setRefreshKey((k) => k + 1)
      }),
    []
  )

  // A settle-capture just landed a new version — re-fetch history for the
  // currently-selected file so the pane updates without waiting for the next
  // repo change or file switch. (Captures write outside the watched repo, so
  // they don't otherwise trigger a refresh.)
  useEffect(() => window.viewmaster.onHistoryChanged(() => setHistoryTick((t) => t + 1)), [])

  /**
   * Resolves an absPath against the current repo listing, synthesizing an
   * "unchanged" entry for a target outside it (e.g. a link/search jump to a
   * file with no git-changed entry in Changed mode) — the same convention
   * Browse Mode's overlayStatus already uses for untouched files.
   */
  const resolveChangedFile = useCallback(
    (absPath: string): ChangedFile | null => {
      if (!repo || (repo.kind !== 'repo' && repo.kind !== 'folder')) return null
      const existing = repo.files.find((f) => sameFsPath(f.absPath, absPath))
      if (existing) return existing
      // Inside the root: repo-relative path. Outside (stdlib, module cache,
      // venv...): the forward-slash absolute path.
      const rel =
        relativeToRoot(absPath, repo.root) ?? absPath.split(String.fromCharCode(92)).join('/')
      return { path: rel, absPath, status: 'unchanged' }
    },
    [repo]
  )

  // `selected` always mirrors the nav stack's current entry, re-resolved
  // against the latest `repo` listing (e.g. after a watcher-driven refresh
  // changes a file's status). Derived directly during render rather than
  // via a separate `useState` synced by an effect, so it can never lag
  // `navigationTarget` (below) by a render tick — both come from the same
  // `navState` read in the same pass. That lag was real: ContentPane's
  // mode-forcing effect keys on [file?.path, navigationTarget], so a stale
  // `file` paired with a fresh `navigationTarget` could transiently force
  // code-mode against the *previous* file for one render after a search
  // jump between two markdown files.
  const selected = useMemo(() => {
    const entry = currentEntry(navState)
    return entry ? resolveChangedFile(entry.absPath) : null
  }, [navState, resolveChangedFile])

  // Reset the revision selection whenever the selected file changes.
  useEffect(() => {
    setSelection(defaultSelection())
    setVersions([])
  }, [selected?.path])

  // Load local history for the selected file (git repos only), refreshing when
  // the watcher reports a change.
  useEffect(() => {
    // External files (outside the opened folder) have no local history.
    if (
      !selected ||
      repo?.kind !== 'repo' ||
      relativeToRoot(selected.absPath, repo.root) === null
    ) {
      setVersions([])
      return
    }
    let stale = false
    void window.viewmaster.historyList(selected.path).then((v) => {
      if (!stale) setVersions(v)
    })
    return () => {
      stale = true
    }
  }, [selected?.path, repo?.kind, refreshKey, historyTick])

  const onSelectRevision = useCallback(
    (ref: RevisionRef): void => {
      setSelection(singleClickSelection(versions, ref))
    },
    [versions]
  )

  const navigateTo = useCallback((absPath: string, target?: NavigationTarget): void => {
    setNavState((s) => pushEntry(s, { absPath, target }))
  }, [])

  const onSidebarSelect = useCallback(
    (file: ChangedFile): void => {
      navigateTo(file.absPath)
    },
    [navigateTo]
  )

  const onGoBack = useCallback((): void => setNavState((s) => goBack(s)), [])
  const onGoForward = useCallback((): void => setNavState((s) => goForward(s)), [])

  // Bridges Monaco's "open a code editor" request (fired for both the
  // TypeScript path's and the heuristic path's definition/reference
  // results) into the app's own navigation history — the same stack
  // Back/Forward already operate on. Monaco calls this callback for
  // EVERY such request, same-file jumps included (confirmed against
  // AbstractCodeEditorService.openCodeEditor's source — it does not skip
  // registered openers for same-resource targets on its own), so the
  // same-file short-circuit inside openCodeEditor below is load-bearing,
  // not defensive: without it every same-file jump would also push a
  // history entry, contradicting the design spec's decision 5 (task 8's
  // manual verification caught exactly this before the check was added).
  useEffect(() => {
    const disposable = monaco.editor.registerEditorOpener({
      openCodeEditor(source, resource, selectionOrPosition) {
        // Monaco calls every registered opener for ANY "open a code
        // editor" request, same-file included — it does not skip this
        // callback for same-file jumps on its own (verified against
        // AbstractCodeEditorService.openCodeEditor, which just tries
        // registered handlers in order). A same-file target moves the
        // cursor in place here — no history entry pushed, matching the
        // design spec's decision 5. (It is not left to Monaco's default
        // handler: that matches models by URI string, and on Windows our
        // models are Uri.parse'd paths while LSP locations are Uri.file
        // URIs, so it silently does nothing.) Only a genuinely different
        // file goes through navigateTo.
        const sourceModel = source.getModel()
        if (sourceModel && sameFsPath(absPathOfModelUri(sourceModel.uri), resource.fsPath)) {
          if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) {
            source.setSelection(selectionOrPosition)
            source.revealRangeInCenterIfOutsideViewport(selectionOrPosition)
          } else if (selectionOrPosition) {
            source.setPosition(selectionOrPosition)
            source.revealPositionInCenterIfOutsideViewport(selectionOrPosition)
          }
          source.focus()
          return true
        }
        const line =
          selectionOrPosition && 'lineNumber' in selectionOrPosition
            ? selectionOrPosition.lineNumber
            : selectionOrPosition && 'startLineNumber' in selectionOrPosition
              ? selectionOrPosition.startLineNumber
              : 1
        navigateTo(resource.fsPath, { kind: 'line', line })
        return true
      }
    })
    return () => disposable.dispose()
  }, [navigateTo])

  const [searchOpen, setSearchOpen] = useState(false)
  const [relatedFilesOpen, setRelatedFilesOpen] = useState(false)
  // Search and Related Files live inside the sidebar pane, so opening them must show it.
  useEffect(
    () =>
      window.viewmaster.onMenuFindInFiles(() => {
        setSidebarVisible(true)
        setSearchOpen(true)
        setSearchFocusRequest((n) => n + 1)
      }),
    []
  )
  useEffect(
    () =>
      window.viewmaster.onMenuRelatedFiles(() => {
        setSidebarVisible(true)
        setRelatedFilesOpen(true)
      }),
    []
  )
  useEffect(
    () => window.viewmaster.onMenuToggleSidebar(() => setSidebarVisible(!sidebarVisibleRef.current)),
    [setSidebarVisible]
  )
  useEffect(() => {
    if (!sidebarVisible) return
    const el = sidebarFocus.current
    sidebarFocus.current = null
    if (el?.isConnected && document.activeElement === document.body) el.focus()
  }, [sidebarVisible])
  useEffect(() => window.viewmaster.onMenuGoBack(onGoBack), [onGoBack])
  useEffect(() => window.viewmaster.onMenuGoForward(onGoForward), [onGoForward])

  const onSelectMatch = useCallback(
    (match: SearchMatch): void => {
      navigateTo(match.absPath, { kind: 'line', line: match.line })
    },
    [navigateTo]
  )

  const onCloseSearch = useCallback((): void => setSearchOpen(false), [])
  const onCloseRelatedFiles = useCallback((): void => setRelatedFilesOpen(false), [])
  const onCloseSidebar = useCallback((): void => setSidebarVisible(false), [setSidebarVisible])
  const onShowSidebar = useCallback((): void => setSidebarVisible(true), [setSidebarVisible])

  const navigationTarget = currentEntry(navState)?.target ?? null

  // Marks the current entry's target as handled so a re-render doesn't keep
  // re-triggering the same scroll/reveal action. Deliberately does not clear
  // on its own if the user has since navigated elsewhere — by the time a
  // consumer calls this, it has just acted on the *current* target, so
  // clearing "whatever entry is current now" is always clearing the right one.
  const onTargetConsumed = useCallback((): void => {
    setNavState((s) => {
      const entry = currentEntry(s)
      if (!entry?.target) return s
      const entries = s.entries.slice()
      entries[s.index] = { absPath: entry.absPath }
      return { ...s, entries }
    })
  }, [])

  if (!repo) {
    return (
      <div className="app">
        <Welcome onOpen={openFolder} />
      </div>
    )
  }

  return (
    <div className="app">
      <div className="app-body">
        {!sidebarVisible && (
          // A thin rail beside the content (not an overlay), so it never covers the toolbar.
          <button
            className="sidebar-rail"
            onClick={onShowSidebar}
            title={`Show sidebar (${SIDEBAR_SHORTCUT})`}
            aria-label="Show sidebar"
          >
            ›
          </button>
        )}
        <div className="app-split">
          <Allotment defaultSizes={[280, 920]}>
            <Allotment.Pane visible={sidebarVisible} minSize={180} preferredSize={280}>
              {/* Allotment only shrinks a hidden pane to 0px; inert keeps its inputs from
                  holding focus or being reached with Tab while it's hidden. */}
              <div className="sidebar-pane" inert={!sidebarVisible}>
                <Allotment vertical>
                  <Allotment.Pane>
                    <Sidebar
                      state={repo}
                      selected={selected?.path ?? null}
                      onSelect={onSidebarSelect}
                      onSetMode={setMode}
                      onSetCustomBaseline={setCustomBaseline}
                      onClose={onCloseSidebar}
                    />
                  </Allotment.Pane>
                  <Allotment.Pane preferredSize={220} minSize={80}>
                    <HistoryPane
                      versions={versions}
                      selection={selection}
                      isGitRepo={repo?.kind === 'repo'}
                      onSelect={onSelectRevision}
                    />
                  </Allotment.Pane>
                  <Allotment.Pane visible={searchOpen} preferredSize={240} minSize={120}>
                    <SearchPane
                      key={repo?.root ?? 'none'}
                      open={searchOpen}
                      focusRequest={searchFocusRequest}
                      onSelectMatch={onSelectMatch}
                      onClose={onCloseSearch}
                    />
                  </Allotment.Pane>
                  <Allotment.Pane visible={relatedFilesOpen} preferredSize={240} minSize={120}>
                    <RelatedFilesPane
                      key={repo?.root ?? 'none'}
                      file={selected}
                      workspaceRoot={repo?.root ?? ''}
                      open={relatedFilesOpen}
                      onNavigate={navigateTo}
                      onClose={onCloseRelatedFiles}
                    />
                  </Allotment.Pane>
                </Allotment>
              </div>
            </Allotment.Pane>
            <Allotment.Pane>
              <ContentPane
                file={selected}
                refreshKey={refreshKey}
                selection={selection}
                versions={versions}
                workspaceRoot={repo?.root ?? ''}
                onNavigate={navigateTo}
                navigationTarget={navigationTarget}
                onTargetConsumed={onTargetConsumed}
                canGoBack={canGoBack(navState)}
                canGoForward={canGoForward(navState)}
                onGoBack={onGoBack}
                onGoForward={onGoForward}
              />
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
      <StatusNotice />
    </div>
  )
}
