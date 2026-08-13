import { useCallback, useEffect, useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { ChangedFile, HistoryVersion, RepoState, SidebarMode } from '@shared/types'
import Sidebar from './components/Sidebar'
import ContentPane from './components/ContentPane'
import HistoryPane from './components/HistoryPane'
import { isInsideRoot } from './html/paths'
import {
  defaultSelection,
  singleClickSelection,
  type RevisionRef,
  type Selection
} from './history/selection'

/** Re-resolve the selected file's object against a fresh RepoState, keeping the same file selected. */
function reconcileSelected(
  state: RepoState,
  current: ChangedFile | null
): ChangedFile | null {
  if (!current) return current
  if (state.kind !== 'repo' && state.kind !== 'folder') return current
  return state.files.find((f) => f.path === current.path) ?? current
}

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
  const [selected, setSelected] = useState<ChangedFile | null>(null)
  const [refreshKey, setRefreshKey] = useState(0)
  const [versions, setVersions] = useState<HistoryVersion[]>([])
  const [selection, setSelection] = useState<Selection>(defaultSelection())
  const [historyTick, setHistoryTick] = useState(0)

  const openFolder = useCallback((root: string): void => {
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setSelected(null)
    })
  }, [])

  const setMode = useCallback((mode: SidebarMode): void => {
    void window.viewmaster.setMode(mode).then((state) => {
      if (!state) return
      setRepo(state)
      setSelected((current) => reconcileSelected(state, current))
    })
  }, [])

  useEffect(() => window.viewmaster.onMenuOpenFolder(openFolder), [openFolder])

  // Watcher-driven auto-refresh: update the change list in place and make
  // the open file re-read its contents.
  useEffect(
    () =>
      window.viewmaster.onRepoChanged((state) => {
        setRepo(state)
        setRefreshKey((k) => k + 1)
        setSelected((current) => reconcileSelected(state, current))
      }),
    []
  )

  // A settle-capture just landed a new version — re-fetch history for the
  // currently-selected file so the pane updates without waiting for the next
  // repo change or file switch. (Captures write outside the watched repo, so
  // they don't otherwise trigger a refresh.)
  useEffect(() => window.viewmaster.onHistoryChanged(() => setHistoryTick((t) => t + 1)), [])

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

  const onNavigateToFile = useCallback(
    (absPath: string): void => {
      if (!repo || (repo.kind !== 'repo' && repo.kind !== 'folder')) return
      const existing = repo.files.find((f) => f.absPath === absPath)
      if (existing) {
        setSelected(existing)
        return
      }
      // Linked file has no git-changed entry in the current listing (e.g.
      // Changed mode with an untouched target) — synthesize the same shape
      // Browse Mode's overlayStatus already gives unchanged files.
      const rel = isInsideRoot(absPath, repo.root)
        ? absPath.slice(repo.root.length).replace(/^\/+/, '')
        : absPath
      setSelected({ path: rel, absPath, status: 'unchanged' })
    },
    [repo]
  )

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
                onSelect={setSelected}
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
          </Allotment>
        </Allotment.Pane>
        <Allotment.Pane>
          <ContentPane
            file={selected}
            refreshKey={refreshKey}
            selection={selection}
            versions={versions}
            workspaceRoot={repo?.root ?? ''}
            onNavigate={onNavigateToFile}
          />
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
