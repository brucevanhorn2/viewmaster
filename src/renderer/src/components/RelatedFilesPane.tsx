// src/renderer/src/components/RelatedFilesPane.tsx
import { useEffect, useState } from 'react'
import type { ChangedFile } from '@shared/types'
import { languageForFile } from '../monacoSetup'
import { extractDeclaredNames } from '../code/declaredSymbols'
import { extractImportSpecifiersForLanguage, candidateImportPathsForLanguage } from '../code/importExtractors'
import { aggregateReferences, type RelatedFile } from '../code/relatedFiles'

function toRelativePath(absPath: string, workspaceRoot: string): string {
  return absPath.startsWith(workspaceRoot)
    ? absPath.slice(workspaceRoot.length).replace(/^\/+/, '')
    : absPath
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
  const [language, setLanguage] = useState('plaintext')

  useEffect(() => {
    setImports([])
    setImportedBy([])
    setReferences([])
    if (!open || !file) return
    let cancelled = false
    setLoading(true)
    const fileName = file.path.split('/').pop() ?? file.path
    const currentLanguage = languageForFile(fileName)
    setLanguage(currentLanguage)
    const lastSlash = file.absPath.lastIndexOf('/')
    const fromDir = lastSlash === -1 ? file.absPath : file.absPath.slice(0, lastSlash)

    void (async () => {
      const content = await window.viewmaster.readFile(file.absPath)
      if (cancelled || content.kind !== 'text') {
        if (!cancelled) setLoading(false)
        return
      }

      // Imports (forward) — resolve each specifier's first existing candidate.
      const specifiers = extractImportSpecifiersForLanguage(currentLanguage, content.content)
      const resolvedImports: RelatedFile[] = []
      for (const specifier of specifiers) {
        for (const candidate of candidateImportPathsForLanguage(currentLanguage, fromDir, specifier)) {
          if (cancelled) break
          const result = await window.viewmaster.readFile(candidate)
          if (result.kind === 'text') {
            resolvedImports.push({ path: toRelativePath(candidate, workspaceRoot), absPath: candidate })
            break
          }
        }
      }
      if (!cancelled) setImports(resolvedImports)

      // Imported by (reverse) — skipped entirely for Go (see design spec decision 5).
      if (!cancelled && currentLanguage !== 'go') {
        const basename = fileName.replace(/\.[^.]+$/, '')
        const result = await window.viewmaster.findImportedBy(basename)
        if (!cancelled) {
          setImportedBy(aggregateReferences([result.locations], file.absPath))
        }
      }

      // References (reverse, symbol-level) — one symbol:references call per declared name.
      const names = extractDeclaredNames(content.content)
      const refResults = await Promise.all(names.map((name) => window.viewmaster.findReferences(name)))
      if (!cancelled) {
        setReferences(aggregateReferences(refResults.map((r) => r.locations), file.absPath))
      }

      if (!cancelled) setLoading(false)
    })()

    return () => {
      cancelled = true
    }
  }, [open, file, workspaceRoot])

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
      ) : (
        <>
          {renderSection('Imports', imports)}
          {language !== 'go' && renderSection('Imported by', importedBy)}
          {renderSection('References', references)}
        </>
      )}
    </div>
  )
}
