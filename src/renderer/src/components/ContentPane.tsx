import { useEffect, useState } from 'react'
import type { ChangedFile, FileContent, HistoryVersion } from '@shared/types'
import { isDefaultSelection, type RevisionRef, type Selection } from '../history/selection'
import type { NavigationTarget } from '../navigation/history'
import CodeView from './CodeView'
import DiffView from './DiffView'
import MarkdownView from './MarkdownView'
import HtmlView from './HtmlView'
import Placeholder from './Placeholder'
import ImageView from './ImageView'
import { rasterDataUrl, svgDataUrl } from '../image/dataUrl'
import PdfView from './PdfView'

type Mode = 'view' | 'marks' | 'code' | 'diff'

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx']

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

const HTML_EXTENSIONS = ['.html', '.htm']

function isHtml(path: string): boolean {
  const lower = path.toLowerCase()
  return HTML_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

const SVG_EXTENSION = '.svg'

function isSvg(path: string): boolean {
  return path.toLowerCase().endsWith(SVG_EXTENSION)
}

export default function ContentPane({
  file,
  refreshKey,
  selection,
  versions,
  workspaceRoot,
  onNavigate,
  navigationTarget,
  onTargetConsumed,
  canGoBack,
  canGoForward,
  onGoBack,
  onGoForward
}: {
  file: ChangedFile | null
  refreshKey: number
  selection: Selection
  versions: HistoryVersion[]
  workspaceRoot: string
  onNavigate: (absPath: string, target?: NavigationTarget) => void
  navigationTarget: NavigationTarget | null
  onTargetConsumed: () => void
  canGoBack: boolean
  canGoForward: boolean
  onGoBack: () => void
  onGoForward: () => void
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('view')
  const [sideBySide, setSideBySide] = useState(true)
  const [content, setContent] = useState<FileContent | null>(null)
  const [baseContent, setBaseContent] = useState<string | null>(null)
  const [compareContent, setCompareContent] = useState<string | null>(null)

  // Reset to rendered/view mode whenever a different file is selected.
  useEffect(() => {
    setMode('view')
  }, [file?.path])

  // A line-targeted navigation into a markdown file needs the raw-text
  // 'code' mode to be meaningful (a rendered-HTML view has no line-number
  // mapping) -- force it once, when the target first arrives. Unlike
  // anchor-kind targets, a line-kind target is deliberately never consumed
  // (there's no onTargetConsumed call for it): CodeView's highlight
  // decoration depends on revealLine staying present as a prop, so clearing
  // it would erase the highlight right after showing it. That means the
  // user's own subsequent mode choice is only respected for the rest of the
  // *current* visit to this history entry -- if they navigate away and
  // later come back to the same entry via Back/Forward, file?.path changes
  // (or this effect re-fires) and the still-present line target re-forces
  // 'code' mode, overriding whatever mode they'd left it in. That's
  // intentional: revisiting a search-jump entry should re-show the
  // highlighted line, the same as re-clicking the search result.
  useEffect(() => {
    if (file && isMarkdown(file.path) && navigationTarget?.kind === 'line') {
      setMode('code')
    }
  }, [file?.path, navigationTarget])

  // A non-default revision selection means "show a diff"; jump into diff mode.
  useEffect(() => {
    if (!isDefaultSelection(selection)) setMode((m) => (m === 'view' ? 'diff' : m))
  }, [selection])

  // Current on-disk content (for view mode + the 'now' ref).
  useEffect(() => {
    if (!file) return
    let stale = false
    void window.viewmaster.readFile(file.absPath).then((c) => {
      if (!stale) setContent(c)
    })
    return () => {
      stale = true
    }
  }, [file, refreshKey])

  // Show the loading placeholder while a newly-selected revision pair resolves.
  useEffect(() => {
    setBaseContent(null)
    setCompareContent(null)
  }, [selection, file?.path, mode])

  // Resolve base/compare sides from the selection when diffing.
  useEffect(() => {
    if (!file || (mode !== 'diff' && mode !== 'marks')) return
    let stale = false
    const resolve = async (ref: RevisionRef): Promise<string> => {
      if (ref === 'baseline') return window.viewmaster.readBaseFile(file.path)
      if (ref === 'now') {
        const c = await window.viewmaster.readFile(file.absPath)
        return c.kind === 'text' ? c.content : ''
      }
      return window.viewmaster.historyRead(ref.sha)
    }
    void resolve(selection.base).then((b) => {
      if (!stale) setBaseContent(b)
    })
    void resolve(selection.compare).then((c) => {
      if (!stale) setCompareContent(c)
    })
    return () => {
      stale = true
    }
  }, [file, mode, selection, refreshKey])

  if (!file) {
    return (
      <div className="content-pane">
        <Placeholder title="Select a file to view it" />
      </div>
    )
  }

  const fileName = file.path.split('/').pop() ?? file.path
  const lineTarget = navigationTarget?.kind === 'line' ? navigationTarget.line : undefined
  const anchorTarget = navigationTarget?.kind === 'anchor' ? navigationTarget.id : null

  // MarkdownView's onNavigate prop is unchanged from issue #5 -- a bare
  // optional anchor string, not a NavigationTarget. This adapts the real
  // (generalized) onNavigate to that shape at the boundary, since
  // MarkdownView itself doesn't change in this plan.
  const onMarkdownNavigate = (absPath: string, anchor?: string): void => {
    onNavigate(absPath, anchor ? { kind: 'anchor', id: anchor } : undefined)
  }

  let body: React.JSX.Element
  if (!content) {
    body = <Placeholder title="Loading…" />
  } else if (content.kind === 'image') {
    body = <ImageView src={rasterDataUrl(content.mime, content.base64)} />
  } else if (content.kind === 'binary') {
    body = <Placeholder title="Binary file" detail="Not displayed" />
  } else if (content.kind === 'too-large') {
    body = (
      <Placeholder
        title="File too large to display"
        detail={`${(content.size / (1024 * 1024)).toFixed(1)} MB`}
      />
    )
  } else if (content.kind === 'missing') {
    body = <Placeholder title="File not found" detail={file.absPath} />
  } else if (content.kind === 'pdf') {
    body = <PdfView base64={content.base64} />
  } else if (isSvg(file.path) && mode === 'code') {
    body = <CodeView fileName={fileName} absPath={file.absPath} content={content.content} />
  } else if (isSvg(file.path)) {
    body = <ImageView src={svgDataUrl(content.content)} />
  } else if (mode === 'diff') {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading diff…" />
      ) : (
        <DiffView
          fileName={fileName}
          original={baseContent}
          modified={compareContent}
          sideBySide={sideBySide}
        />
      )
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null || compareContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView
          content={compareContent}
          baseContent={baseContent}
          absPath={file.absPath}
          workspaceRoot={workspaceRoot}
          onNavigate={onMarkdownNavigate}
          scrollToAnchor={anchorTarget}
          onAnchorConsumed={onTargetConsumed}
        />
      )
  } else if (mode === 'code' && isMarkdown(file.path)) {
    body = <CodeView fileName={fileName} absPath={file.absPath} content={content.content} revealLine={lineTarget} />
  } else if (isMarkdown(file.path)) {
    body = (
      <MarkdownView
        content={content.content}
        absPath={file.absPath}
        workspaceRoot={workspaceRoot}
        onNavigate={onMarkdownNavigate}
        scrollToAnchor={anchorTarget}
        onAnchorConsumed={onTargetConsumed}
      />
    )
  } else if (mode === 'code' && isHtml(file.path)) {
    body = <CodeView fileName={fileName} absPath={file.absPath} content={content.content} revealLine={lineTarget} />
  } else if (isHtml(file.path)) {
    body = (
      <HtmlView
        content={content.content}
        absPath={file.absPath}
        workspaceRoot={workspaceRoot}
        onNavigate={onNavigate}
      />
    )
  } else {
    body = <CodeView fileName={fileName} absPath={file.absPath} content={content.content} revealLine={lineTarget} />
  }

  const showToolbarToggles = content?.kind === 'text'

  return (
    <div className="content-pane">
      <div className="toolbar">
        <span className="toolbar-nav">
          <button className="toolbar-button" onClick={onGoBack} disabled={!canGoBack} title="Back">
            ←
          </button>
          <button
            className="toolbar-button"
            onClick={onGoForward}
            disabled={!canGoForward}
            title="Forward"
          >
            →
          </button>
        </span>
        <span className="toolbar-path" title={file.absPath}>
          {file.path}
        </span>
        <span className="toolbar-actions">
          {showToolbarToggles && mode === 'diff' && !isSvg(file.path) && (
            <button className="toolbar-button" onClick={() => setSideBySide(!sideBySide)}>
              {sideBySide ? 'Inline' : 'Side by side'}
            </button>
          )}
          {showToolbarToggles && isSvg(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'code'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : 'Code'}
                </button>
              ))}
            </span>
          ) : showToolbarToggles && isMarkdown(file.path) ? (
            <span className="toolbar-segment">
              {(['view', 'marks', 'diff'] as const).map((m) => (
                <button
                  key={m}
                  className={`toolbar-button${mode === m ? ' active' : ''}`}
                  onClick={() => setMode(m)}
                >
                  {m === 'view' ? 'Rendered' : m === 'marks' ? 'Marks' : 'Source'}
                </button>
              ))}
            </span>
          ) : showToolbarToggles && isHtml(file.path) ? (
            <>
              <span className="toolbar-segment">
                {(['view', 'code', 'diff'] as const).map((m) => (
                  <button
                    key={m}
                    className={`toolbar-button${mode === m ? ' active' : ''}`}
                    onClick={() => setMode(m)}
                  >
                    {m === 'view' ? 'Rendered' : m === 'code' ? 'Code' : 'Diff'}
                  </button>
                ))}
              </span>
              <button
                className="toolbar-button"
                onClick={() => window.viewmaster.openInBrowser(file.absPath)}
              >
                Open in Default Browser
              </button>
            </>
          ) : (
            showToolbarToggles && (
              <button
                className={`toolbar-button${mode === 'diff' ? ' active' : ''}`}
                onClick={() => setMode(mode === 'diff' ? 'view' : 'diff')}
              >
                Diff
              </button>
            )
          )}
        </span>
      </div>
      <div className="content-body">{body}</div>
    </div>
  )
}
