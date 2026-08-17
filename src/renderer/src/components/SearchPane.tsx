import { useEffect, useRef, useState } from 'react'
import type { SearchMatch } from '@shared/types'

const DEBOUNCE_MS = 250

export default function SearchPane({
  open,
  onSelectMatch,
  onClose
}: {
  open: boolean
  onSelectMatch: (match: SearchMatch) => void
  onClose: () => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<SearchMatch[]>([])
  const [truncated, setTruncated] = useState(false)
  const [searching, setSearching] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  useEffect(() => {
    if (query.trim() === '') {
      ++requestIdRef.current
      setMatches([])
      setTruncated(false)
      setSearching(false)
      return
    }
    setSearching(true)
    const timer = setTimeout(() => {
      const requestId = ++requestIdRef.current
      void window.viewmaster.search(query)
        .then((result) => {
          if (requestIdRef.current !== requestId) return
          setMatches(result.matches)
          setTruncated(result.truncated)
          setSearching(false)
        })
        .catch(() => {
          if (requestIdRef.current !== requestId) return
          setMatches([])
          setTruncated(false)
          setSearching(false)
        })
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [query])

  const byFile = new Map<string, SearchMatch[]>()
  for (const match of matches) {
    const existing = byFile.get(match.path)
    if (existing) existing.push(match)
    else byFile.set(match.path, [match])
  }

  return (
    <div className="search-pane">
      <div className="search-title">
        Search
        <button className="search-close" onClick={onClose} title="Close">
          ×
        </button>
      </div>
      <input
        ref={inputRef}
        className="search-input"
        type="text"
        placeholder="Find in files…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
      />
      {!searching && query.trim() !== '' && matches.length === 0 && (
        <div className="search-empty">No matches.</div>
      )}
      <ul className="search-results">
        {Array.from(byFile.entries()).map(([path, fileMatches]) => (
          <li key={path} className="search-result-file">
            <div className="search-result-file-name" title={path}>
              {path}
            </div>
            <ul className="search-result-lines">
              {fileMatches.map((match) => (
                <li
                  key={`${match.line}:${match.column}`}
                  className="search-result-row"
                  onClick={() => onSelectMatch(match)}
                >
                  <span className="search-result-line-number">{match.line}</span>
                  <span className="search-result-preview">
                    {match.preview.slice(0, match.previewColumn)}
                    <mark>{match.preview.slice(match.previewColumn, match.previewColumn + query.length)}</mark>
                    {match.preview.slice(match.previewColumn + query.length)}
                  </span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ul>
      {truncated && (
        <div className="search-truncated">Showing partial results — refine your search.</div>
      )}
    </div>
  )
}
