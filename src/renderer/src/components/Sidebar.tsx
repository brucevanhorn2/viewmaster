import { useEffect, useMemo, useState } from 'react'
import type { ChangedFile, FileStatus, RepoState, SidebarMode } from '@shared/types'
import { buildTree, type TreeNode } from '@shared/tree'
import { fileIconUrl, folderIconUrl } from '../icons'
import { baselineLabel } from '../code/baselineLabel'

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

/**
 * Joins a native, OS-separated root path with a forward-slash-only
 * relative path (TreeNode.path is always '/'-joined, matching
 * ChangedFile.path's own convention, regardless of platform). Detects
 * root's separator rather than assuming '/', since the renderer has no
 * access to Node's path.join (contextIsolation) and a hardcoded '/' would
 * produce a mixed-separator path like 'C:\repo/src' on Windows.
 */
function joinRootPath(root: string, relativePath: string): string {
  const separator = root.includes('\\') ? '\\' : '/'
  return `${root}${separator}${relativePath.replace(/\//g, separator)}`
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
        onContextMenu={(e) => onContextMenu(e, joinRootPath(root, node.path), false)}
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
  onSetMode,
  onSetCustomBaseline
}: {
  state: RepoState
  selected: string | null
  onSelect: (file: ChangedFile) => void
  onSetMode: (mode: SidebarMode) => void
  onSetCustomBaseline: (ref: string | null) => void
}): React.JSX.Element {
  const [menu, setMenu] = useState<ContextMenuState | null>(null)
  const [editingBaseline, setEditingBaseline] = useState(false)
  const [baselineInput, setBaselineInput] = useState('')
  const [refSuggestions, setRefSuggestions] = useState<string[]>([])

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

  const startEditingBaseline = (): void => {
    if (state.kind !== 'repo') return
    setBaselineInput(state.baseline.kind === 'custom' ? state.baseline.ref : '')
    setEditingBaseline(true)
    void window.viewmaster.listRefs().then(setRefSuggestions)
  }

  const commitBaseline = (ref: string): void => {
    setEditingBaseline(false)
    const trimmed = ref.trim()
    onSetCustomBaseline(trimmed === '' ? null : trimmed)
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
        {state.kind === 'repo' && editingBaseline ? (
          <span className="baseline-picker">
            <input
              autoFocus
              className="baseline-picker-input"
              list="baseline-ref-suggestions"
              value={baselineInput}
              placeholder="branch, tag, or commit"
              onChange={(e) => setBaselineInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') commitBaseline(baselineInput)
                if (e.key === 'Escape') setEditingBaseline(false)
              }}
              onBlur={() => commitBaseline(baselineInput)}
            />
            <datalist id="baseline-ref-suggestions">
              {refSuggestions.map((ref) => (
                <option key={ref} value={ref} />
              ))}
            </datalist>
          </span>
        ) : (
          <span
            className={`sidebar-header-label${state.kind === 'repo' ? ' sidebar-header-label-clickable' : ''}`}
            onClick={state.kind === 'repo' ? startEditingBaseline : undefined}
          >
            {state.kind === 'folder' ? state.root : baselineLabel(state.baseline)}
          </span>
        )}
        {state.kind === 'repo' && state.baseline.kind === 'custom' && !editingBaseline && (
          <button
            className="toolbar-button baseline-reset"
            title="Reset to auto-detected baseline"
            onClick={() => onSetCustomBaseline(null)}
          >
            ×
          </button>
        )}
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
