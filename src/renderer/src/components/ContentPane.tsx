import { useEffect, useState } from 'react'
import type { ChangedFile, FileContent } from '@shared/types'
import CodeView from './CodeView'
import DiffView from './DiffView'
import MarkdownView from './MarkdownView'
import Placeholder from './Placeholder'

type Mode = 'view' | 'marks' | 'diff'

const MARKDOWN_EXTENSIONS = ['.md', '.markdown', '.mdx']

function isMarkdown(path: string): boolean {
  const lower = path.toLowerCase()
  return MARKDOWN_EXTENSIONS.some((ext) => lower.endsWith(ext))
}

export default function ContentPane({
  file,
  refreshKey
}: {
  file: ChangedFile | null
  refreshKey: number
}): React.JSX.Element {
  const [mode, setMode] = useState<Mode>('view')
  const [sideBySide, setSideBySide] = useState(true)
  const [content, setContent] = useState<FileContent | null>(null)
  const [baseContent, setBaseContent] = useState<string | null>(null)

  // Reset to rendered/view mode when switching files.
  useEffect(() => {
    setMode('view')
  }, [file?.path])

  useEffect(() => {
    if (!file) return
    let stale = false
    void window.viewmaster.readFile(file.absPath).then((c) => {
      if (!stale) setContent(c)
    })
    if (mode === 'diff' || mode === 'marks') {
      void window.viewmaster.readBaseFile(file.path).then((base) => {
        if (!stale) setBaseContent(base)
      })
    }
    return () => {
      stale = true
    }
  }, [file, mode, refreshKey])

  if (!file) {
    return (
      <div className="content-pane">
        <Placeholder title="Select a file to view it" />
      </div>
    )
  }

  const fileName = file.path.split('/').pop() ?? file.path

  let body: React.JSX.Element
  if (!content) {
    body = <Placeholder title="Loading…" />
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
  } else if (mode === 'diff') {
    body =
      baseContent === null ? (
        <Placeholder title="Loading diff…" />
      ) : (
        <DiffView
          fileName={fileName}
          original={baseContent}
          modified={content.content}
          sideBySide={sideBySide}
        />
      )
  } else if (mode === 'marks' && isMarkdown(file.path)) {
    body =
      baseContent === null ? (
        <Placeholder title="Loading marks…" />
      ) : (
        <MarkdownView content={content.content} baseContent={baseContent} />
      )
  } else if (isMarkdown(file.path)) {
    body = <MarkdownView content={content.content} />
  } else {
    body = <CodeView fileName={fileName} content={content.content} />
  }

  const showToolbarToggles = content?.kind === 'text'

  return (
    <div className="content-pane">
      <div className="toolbar">
        <span className="toolbar-path" title={file.absPath}>
          {file.path}
        </span>
        <span className="toolbar-actions">
          {showToolbarToggles && mode === 'diff' && (
            <button className="toolbar-button" onClick={() => setSideBySide(!sideBySide)}>
              {sideBySide ? 'Inline' : 'Side by side'}
            </button>
          )}
          {showToolbarToggles && isMarkdown(file.path) ? (
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
