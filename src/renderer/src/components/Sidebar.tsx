import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, FileStatus, RepoState } from '@shared/types'
import { buildTree, type TreeNode } from '@shared/tree'
import { fileIconUrl, folderIconUrl } from '../icons'

const STATUS_LETTER: Record<FileStatus, string> = {
  untracked: 'U',
  modified: 'M',
  staged: 'S',
  committed: 'C'
}

interface ContextMenuState {
  x: number
  y: number
  file: ChangedFile
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
  onContextMenu: (e: React.MouseEvent, file: ChangedFile) => void
}): React.JSX.Element {
  const name = file.path.split('/').pop() ?? file.path
  return (
    <div
      className={`tree-row file-row status-${file.status}${selected ? ' selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      onClick={() => onSelect(file)}
      onContextMenu={(e) => onContextMenu(e, file)}
      title={file.path}
    >
      <img className="file-icon" src={fileIconUrl(name)} alt="" />
      <span className="file-name">{name}</span>
      <span className="status-badge">
        {STATUS_LETTER[file.status]}
        {file.secondary && <span className="status-secondary">·{STATUS_LETTER[file.secondary]}</span>}
      </span>
    </div>
  )
}

function DirNode({
  node,
  depth,
  selected,
  onSelect,
  onContextMenu
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, file: ChangedFile) => void
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(true)
  return (
    <div>
      <div
        className="tree-row dir-row"
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => setExpanded(!expanded)}
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
  onContextMenu
}: {
  node: TreeNode
  depth: number
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onContextMenu: (e: React.MouseEvent, file: ChangedFile) => void
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
  onSelect
}: {
  state: RepoState
  selected: string | null
  onSelect: (file: ChangedFile) => void
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
    () => (state.kind === 'repo' ? buildTree(state.files) : null),
    [state]
  )

  if (state.kind === 'not-git') {
    return (
      <div className="sidebar">
        <div className="sidebar-message">
          Not a git repository
          <div className="sidebar-message-detail">{state.root}</div>
        </div>
      </div>
    )
  }

  if (state.kind === 'error') {
    return (
      <div className="sidebar">
        <div className="sidebar-message">
          Git error
          <div className="sidebar-message-detail">{state.message}</div>
        </div>
      </div>
    )
  }

  const onContextMenu = (e: React.MouseEvent, file: ChangedFile): void => {
    e.preventDefault()
    e.stopPropagation()
    setMenu({ x: e.clientX, y: e.clientY, file })
  }

  return (
    <div className="sidebar">
      <div className="sidebar-header" title={state.root}>
        {baselineLabel(state)}
      </div>
      <div className="sidebar-tree">
        {tree && tree.dirs.length === 0 && tree.files.length === 0 ? (
          <div className="sidebar-message">No changes in this branch</div>
        ) : (
          tree && (
            <Children
              node={tree}
              depth={0}
              selected={selected}
              onSelect={onSelect}
              onContextMenu={onContextMenu}
            />
          )
        )}
      </div>
      {menu && (
        <div className="context-menu" style={{ left: menu.x, top: menu.y }}>
          <div
            className="context-menu-item"
            onClick={() => {
              window.viewmaster.copyPath(menu.file.absPath)
              setMenu(null)
            }}
          >
            Copy absolute path
          </div>
        </div>
      )}
    </div>
  )
}
