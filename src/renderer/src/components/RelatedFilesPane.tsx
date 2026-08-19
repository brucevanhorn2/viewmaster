// src/renderer/src/components/RelatedFilesPane.tsx
import { useEffect, useState } from 'react'
import type { ChangedFile } from '@shared/types'
import { languageForFile } from '../monacoSetup'
import { extractDeclaredNames } from '../code/declaredSymbols'
import { extractImportSpecifiersForLanguage, candidateImportPathsForLanguage } from '../code/importExtractors'
import { aggregateReferences, type RelatedFile } from '../code/relatedFiles'

function workspacePrefix(workspaceRoot: string): string {
  return workspaceRoot.endsWith('/') ? workspaceRoot : workspaceRoot + '/'
}

function isInsideWorkspace(absPath: string, workspaceRoot: string): boolean {
  return absPath.startsWith(workspacePrefix(workspaceRoot))
}

function toRelativePath(absPath: string, workspaceRoot: string): string {
  const prefix = workspacePrefix(workspaceRoot)
  return absPath.startsWith(prefix) ? absPath.slice(prefix.length) : absPath
}

export default function RelatedFilesPane({
  file,
  workspaceRoot,
  open,
  onNavigate,
  onClose
}: {
  file: ChangedFile | null
  workspaceRoot: string
  open: boolean
  onNavigate: (absPath: string) => void
  onClose: () => void
}): React.JSX.Element {
  const [imports, setImports] = useState<RelatedFile[]>([])
  const [importedBy, setImportedBy] = useState<RelatedFile[]>([])
  const [references, setReferences] = useState<RelatedFile[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [language, setLanguage] = useState('plaintext')

  useEffect(() => {
    setImports([])
    setImportedBy([])
    setReferences([])
    setError(null)
    if (!open || !file) return
    let cancelled = false
    setLoading(true)
    const fileName = file.path.split('/').pop() ?? file.path
    const currentLanguage = languageForFile(fileName)
    setLanguage(currentLanguage)
    const lastSlash = file.absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? file.absPath : file.absPath.slice(0, lastSlash)

    void (async () => {
      try {
        // Imported by (reverse) — only needs the basename, independent of
        // whether the file's own content can be read as text. Skipped
        // entirely for Go (see design spec decision 5 — no file-relative
        // import resolution without go.mod).
        if (!cancelled && currentLanguage !== 'go') {
          const basename = fileName.replace(/\.[^.]+$/, '')
          const result = await window.viewmaster.findImportedBy(basename)
          if (result.error) throw new Error(result.error)
          if (!cancelled) {
            setImportedBy(aggregateReferences([result.locations], file.absPath))
          }
        }

        const content = await window.viewmaster.readFile(file.absPath)
        if (cancelled) return
        if (content.kind !== 'text') return

        // Imports (forward) — skipped entirely for Go, same reasoning as
        // Imported by. Resolve each specifier's first existing candidate,
        // in parallel across specifiers (sequential only within one
        // specifier's own candidate-suffix list, since that's a
        // first-match-wins probe). Only candidates inside the workspace
        // root are kept (design spec decision 6 — no navigation outside
        // the open folder).
        if (currentLanguage !== 'go') {
          const specifiers = extractImportSpecifiersForLanguage(currentLanguage, content.content)
          const resolved = await Promise.all(
            specifiers.map(async (specifier) => {
              for (const candidate of candidateImportPathsForLanguage(currentLanguage, fromDir, specifier)) {
                if (cancelled) return null
                const result = await window.viewmaster.readFile(candidate)
                if (result.kind === 'text') {
                  return isInsideWorkspace(candidate, workspaceRoot)
                    ? { path: toRelativePath(candidate, workspaceRoot), absPath: candidate }
                    : null
                }
              }
              return null
            })
          )
          if (!cancelled) setImports(resolved.filter((r): r is RelatedFile => r !== null))
        }

        // References (reverse, symbol-level) — one batched related:references
        // call over all declared names, not one symbol:references call per
        // name (that fan-out self-aborts: symbol:references is single-flight).
        const names = extractDeclaredNames(content.content)
        if (names.length > 0) {
          const result = await window.viewmaster.findRelatedReferences(names)
          if (result.error) throw new Error(result.error)
          if (!cancelled) {
            setReferences(aggregateReferences([result.locations], file.absPath))
          }
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()

    return () => {
      cancelled = true
    }
  }, [open, file?.absPath, workspaceRoot])

  const renderSection = (title: string, items: RelatedFile[]): React.JSX.Element => (
    <div className="related-files-section">
      <div className="related-files-section-title">{title}</div>
      {items.length === 0 ? (
        <div className="related-files-empty">None found.</div>
      ) : (
        <ul className="related-files-list">
          {items.map((item) => (
            <li
              key={item.absPath}
              className="related-files-row"
              onClick={() => onNavigate(item.absPath)}
              title={item.path}
            >
              {item.path}
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  return (
    <div className="related-files-pane">
      <div className="related-files-title">
        Related Files
        <button className="related-files-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      {!file ? (
        <div className="related-files-empty">Select a file to see related files.</div>
      ) : loading ? (
        <div className="related-files-loading">Loading…</div>
      ) : error ? (
        <div className="related-files-empty">Error: {error}</div>
      ) : (
        <>
          {language !== 'go' && renderSection('Imports', imports)}
          {language !== 'go' && renderSection('Imported by', importedBy)}
          {renderSection('References', references)}
        </>
      )}
    </div>
  )
}
