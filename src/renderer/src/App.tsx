import { useCallback, useEffect, useState } from 'react'
import { Allotment } from 'allotment'
import 'allotment/dist/style.css'
import type { ChangedFile, RepoState } from '@shared/types'
import Sidebar from './components/Sidebar'
import ContentPane from './components/ContentPane'

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
      <h1>viewmaster</h1>
      <p>Read-only viewer for markdown documents and branch diffs.</p>
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

  const openFolder = useCallback((root: string): void => {
    void window.viewmaster.openRepo(root).then((state) => {
      setRepo(state)
      setSelected(null)
    })
  }, [])

  useEffect(() => window.viewmaster.onMenuOpenFolder(openFolder), [openFolder])

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
          <Sidebar state={repo} selected={selected?.path ?? null} onSelect={setSelected} />
        </Allotment.Pane>
        <Allotment.Pane>
          <ContentPane file={selected} refreshKey={0} />
        </Allotment.Pane>
      </Allotment>
    </div>
  )
}
