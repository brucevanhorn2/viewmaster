// src/renderer/src/markdown/useDocumentPanZoom.ts
import { useEffect, useRef } from 'react'
import { runMermaidIn } from './mermaidRunner'
import { attachDocumentPanZoom, type DocumentPanZoom } from './documentPanZoom'

type SavedStates = ReturnType<DocumentPanZoom['states']>

/**
 * Runs mermaid over the container's rendered markdown, then attaches map-style
 * pan/zoom to its diagrams and images. Re-runs whenever `html` changes.
 *
 * Zoom state survives a reload of the SAME document (same pathKey) and resets
 * to Fit for a different one: states are captured from the previous instance
 * and tagged with the pathKey it was attached under.
 */
export function useDocumentPanZoom(
  ref: React.RefObject<HTMLElement | null>,
  html: string,
  pathKey: string
): void {
  // Read when the effect starts: html and its pathKey change together, while reading it after
  // the async mermaid pass could tag one document's states with the next document's key.
  const pathKeyRef = useRef(pathKey)
  pathKeyRef.current = pathKey
  const current = useRef<{ pz: DocumentPanZoom; key: string } | null>(null)
  const saved = useRef<{ key: string; states: SavedStates } | null>(null)

  useEffect(() => {
    const container = ref.current
    if (!container || !html) return
    let stale = false
    const key = pathKeyRef.current

    const attach = (): void => {
      if (stale) return
      const prior = saved.current
      current.current = {
        pz: attachDocumentPanZoom(container, prior && prior.key === key ? prior.states : null),
        key
      }
    }
    // A mermaid failure must not leave diagrams/images without pan/zoom and
    // must not surface as an unhandled rejection: attach anyway.
    runMermaidIn(container).then(attach, attach)

    return () => {
      stale = true
      const cur = current.current
      if (cur) {
        saved.current = { key: cur.key, states: cur.pz.states() }
        cur.pz.destroy()
        current.current = null
      }
    }
  }, [ref, html])
}
