// src/renderer/src/components/HistoryPane.tsx
import type { HistoryVersion } from '@shared/types'
import {
  baselineLabel,
  nowLabel,
  sameRef,
  type RevisionRef,
  type Selection
} from '../history/selection'

const timeLabel = (ts: number): string =>
  new Date(ts).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })

function isSelected(sel: Selection, ref: RevisionRef): 'base' | 'compare' | null {
  if (sameRef(sel.base, ref)) return 'base'
  if (sameRef(sel.compare, ref)) return 'compare'
  return null
}

export default function HistoryPane({
  versions,
  selection,
  isGitRepo,
  onSelect
}: {
  versions: HistoryVersion[]
  selection: Selection
  isGitRepo: boolean
  onSelect: (ref: RevisionRef, additive: boolean) => void
}): React.JSX.Element {
  if (!isGitRepo) {
    return (
      <div className="history-pane">
        <div className="history-title">History</div>
        <div className="history-empty">Not a git repo — no local history.</div>
      </div>
    )
  }

  const rows: Array<{ key: string; ref: RevisionRef; label: string }> = [
    { key: 'now', ref: 'now', label: nowLabel() },
    ...[...versions].reverse().map((v) => ({ key: v.sha, ref: { sha: v.sha }, label: timeLabel(v.ts) })),
    { key: 'baseline', ref: 'baseline', label: baselineLabel() }
  ]

  return (
    <div className="history-pane">
      <div className="history-title">History</div>
      {versions.length === 0 ? (
        <div className="history-empty">No local history yet — edits appear here as you work.</div>
      ) : (
        <ul className="history-list">
          {rows.map((row) => {
            const role = isSelected(selection, row.ref)
            return (
              <li
                key={row.key}
                className={`history-row${role ? ` sel-${role}` : ''}`}
                onClick={(e) => onSelect(row.ref, e.metaKey || e.shiftKey)}
              >
                <span className="history-dot" />
                <span className="history-label">{row.label}</span>
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
