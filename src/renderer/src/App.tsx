import { useCallback, useEffect, useMemo, useState } from 'react'
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

  const openFolder = useCallback((root: string): void => {
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setNavState(initialNavigationState())
    })
  }, [])

  const openFile = useCallback((payload: { root: string; absPath: string }): void => {
    void window.viewmaster.openRepo(payload.root).then((state) => {
      setRepo(state)
      setNavState(pushEntry(initialNavigationState(), { absPath: payload.absPath }))
    })
  }, [])

  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
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
      const existing = repo.files.find((f) => f.absPath === absPath)
      if (existing) return existing
      const rel = absPath.startsWith(repo.root)
        ? absPath.slice(repo.root.length).replace(/^\/+/, '')
        : absPath
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
    if (!selected || repo?.kind !== 'repo') {
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
        // registered handlers in order). Returning `false` here for a
        // same-file target falls through to Monaco's own default handler
        // (StandaloneCodeEditorService's built-in one, registered before
        // ours), which moves the cursor within the current model natively
        // — no history entry pushed, matching the design spec's decision
        // 5. Only a genuinely different file goes through navigateTo.
        if (source.getModel()?.uri.fsPath === resource.fsPath) {
          return false
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

  useEffect(() => window.viewmaster.onMenuFindInFiles(() => setSearchOpen(true)), [])
  useEffect(() => window.viewmaster.onMenuRelatedFiles(() => setRelatedFilesOpen(true)), [])
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
      <Allotment defaultSizes={[280, 920]}>
        <Allotment.Pane minSize={180} preferredSize={280}>
          <Allotment vertical>
            <Allotment.Pane>
              <Sidebar
                state={repo}
                selected={selected?.path ?? null}
                onSelect={onSidebarSelect}
                onSetMode={setMode}
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
  )
}
