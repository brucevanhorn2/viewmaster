import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, FileStatus, RepoState, SidebarMode } from '@shared/types'
import { buildTree, type TreeNode } from '@shared/tree'
import { fileIconUrl, folderIconUrl } from '../icons'

const STATUS_LETTER: Record<FileStatus, string> = {
  untracked: 'U',
  modified: 'M',
  staged: 'S',
  committed: 'C',
  unchanged: ''
}

interface ContextMenuState {
  x: number
  y: number
  absPath: string
  isFile: boolean
}

function baselineLabel(state: RepoState & { kind: 'repo' }): string {
  const b = state.baseline
  if (b.kind === 'merge-base') return `${b.branch} vs ${b.defaultBranch}`
  const reasons: Record<string, string> = {
    detached: 'detached HEAD',
    'on-default': `on ${b.branch ?? 'default branch'}`,
    'no-commits': 'no commits yet',
    'no-baseline': 'no baseline branch'
  }
  return `Working tree changes only (${reasons[b.reason]})`
}

function FileRow({
  file,
  depth,
  selected,
  onSelect,
  onContextMenu
}: {
  file: ChangedFile
  depth: number
  selected: boolean
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, absPath: string, isFile: boolean) => void
}): React.JSX.Element {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <div
      className={`tree-row file-row status-${file.status}${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(file)}
      onContextMenu={(e) => onContextMenu(e, file.absPath, true)}
      title={file.path}
    >
      <img className="file-icon" src={fileIconUrl(name)} alt="" />
      <span className="file-name">{name}</span>
      {file.status !== 'unchanged' && (
        <span className="status-badge">
          {STATUS_LETTER[file.status]}
          {file.secondary && <span className="status-secondary">·{STATUS_LETTER[file.secondary]}</span>}
        </span>
      )}
    </div>
  )
}

function DirNode({
  node,
  depth,
  selected,
  onSelect,
  onContextMenu,
  root
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, absPath: string, isFile: boolean) => void
  root: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <div>
      <div
        className="tree-row dir-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setExpanded(!expanded)}
        onContextMenu={(e) => onContextMenu(e, `${root}/${node.path}`, false)}
      >
        <span className={`chevron${expanded ? ' expanded' : ''}`}>›</span>
        <img className="file-icon" src={folderIconUrl(node.name, expanded)} alt="" />
        <span className="dir-name">{node.name}</span>
      </div>
      {expanded && (
        <Children
          node={node}
          depth={depth + 1}
          selected={selected}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          root={root}
        />
      )}
    </div>
  )
}

function Children({
  node,
  depth,
  selected,
  onSelect,
  onContextMenu,
  root
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, absPath: string, isFile: boolean) => void
  root: string
}): React.JSX.Element {
  return (
    <>
      {node.dirs.map((dir) => (
        <DirNode
          key={dir.path}
          node={dir}
          depth={depth}
          selected={selected}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
          root={root}
        />
      ))}
      {node.files.map((file) => (
        <FileRow
          key={file.path}
          file={file}
          depth={depth}
          selected={selected === file.path}
          onSelect={onSelect}
          onContextMenu={onContextMenu}
        />
      ))}
    </>
  )
}

export default function Sidebar({
  state,
  selected,
  onSelect,
  onSetMode
}: {
  state: RepoState
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onSetMode: (mode: SidebarMode) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)

  useEffect(() => {
    if (!menu) return
    const close = (): void => setMenu(null)
    window.addEventListener('click', close)
    window.addEventListener('contextmenu', close, true)
    return () => {
      window.removeEventListener('click', close)
      window.removeEventListener('contextmenu', close, true)
    }
  }, [menu])

  const tree = useMemo(
    () => (state.kind === 'repo' || state.kind === 'folder' ? buildTree(state.files) : null),
    [state]
  )

  if (state.kind === 'error') {
    return (
      <div className="sidebar">
        <div className="sidebar-message">
          Couldn&apos;t open folder
          <div className="sidebar-message-detail">{state.message}</div>
        </div>
      </div>
    )
  }

  const onContextMenu = (e: React.MouseEvent, absPath: string, isFile: boolean): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, absPath, isFile })
  }

  const emptyMessage =
    state.kind === 'folder' || (state.kind === 'repo' && state.mode === 'browse')
      ? 'No files to show'
      : 'No changes in this branch'

  return (
    <div className="sidebar">
      <div
        className="sidebar-header"
        title={state.root}
        onContextMenu={(e) => onContextMenu(e, state.root, false)}
      >
        <span className="sidebar-header-label">
          {state.kind === 'folder' ? state.root : baselineLabel(state)}
        </span>
        {state.kind === 'repo' && (
          <span className="toolbar-segment">
            {(['changed', 'browse'] as const).map((m) => (
              <button
                key={m}
                className={`toolbar-button${state.mode === m ? ' active' : ''}`}
                onClick={() => onSetMode(m)}
              >
                {m === 'changed' ? 'Changed' : 'Browse'}
              </button>
            ))}
          </span>
        )}
      </div>
      <div className="sidebar-tree">
        {tree && tree.dirs.length === 0 && tree.files.length === 0 ? (
          <div className="sidebar-message">{emptyMessage}</div>
        ) : (
          tree && (
            <Children
              node={tree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
              root={state.root}
            />
          )
        )}
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          {menu.isFile && (
            <div
              className="context-menu-item"
              onClick={() => {
                window.viewmaster.copyPath(menu.absPath)
                setMenu(null)
              }}
            >
              Copy absolute path
            </div>
          )}
          <div
            className="context-menu-item"
            onClick={() => {
              window.viewmaster.showInFolder(menu.absPath)
              setMenu(null)
            }}
          >
            Open location
          </div>
        </div>
      )}
    </div>
  )
}
