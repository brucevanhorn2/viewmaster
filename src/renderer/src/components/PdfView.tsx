import { useEffect, useRef, useState } from 'react'
import { getDocument } from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import '../pdf/worker' // side effect: configures the bundled pdf.js worker
import { base64ToBytes } from '../pdf/base64'
import Placeholder from './Placeholder'

export default function PdfView({ base64 }: { base64: string }): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const renderTaskRef = useRef<RenderTask | null>(null)
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageNumber, setPageNumber] = useState(1)
  const [failed, setFailed] = useState(false)

  // Load the document whenever the underlying bytes change.
  //
  // `task` (a PDFDocumentLoadingTask) is only ever destroyed here while the
  // load itself is still in flight (cancelling it). Once it has resolved and
  // handed off its PDFDocumentProxy via setPdfDoc, destruction of that proxy
  // is owned exclusively by the effect below (keyed on [pdfDoc]) so that it
  // happens in the same commit as the render effect's own cleanup — see that
  // effect's comment for why this matters.
  useEffect(() => {
    let stale = false
    let handedOff = false
    setFailed(false)
    setPdfDoc(null)
    setPageNumber(1)
    const task = getDocument({ data: base64ToBytes(base64) })
    task.promise.then(
      (doc) => {
        if (stale) {
          // Superseded before the load finished; nothing has taken ownership
          // of this document yet, so we're responsible for tearing it down.
          void task.destroy()
          return
        }
        handedOff = true
        setPdfDoc(doc)
      },
      () => {
        if (!stale) setFailed(true)
      }
    )
    return () => {
      stale = true
      if (!handedOff) void task.destroy()
    }
  }, [base64])

  // Destroy a resolved document exactly when `pdfDoc` state moves away from
  // it. PDFDocumentProxy has no destroy() of its own (pdfjs-dist 6.x) — the
  // real teardown lives on its PDFDocumentLoadingTask (`pdfDoc.loadingTask`,
  // the same task object created above), which destroys the shared worker
  // transport. Tying that call to the [pdfDoc] dependency — rather than to
  // the [base64] load effect's cleanup firing independently — guarantees it
  // runs in the same React commit as the render effect's cleanup below
  // (both depend on pdfDoc), so the render effect's own `stale` flag is
  // always flipped before the transport actually goes away.
  useEffect(() => {
    if (!pdfDoc) return
    return () => {
      void pdfDoc.loadingTask.destroy()
    }
  }, [pdfDoc])

  // Render the current page at a scale that fits the container's width.
  // A ResizeObserver fires once immediately on observe() (in addition to on
  // actual resizes), so this alone drives both the initial render and
  // re-renders on pane/window resize — no separate initial-render call needed.
  //
  // The observer passes contentRect.width, which excludes the container's
  // padding/border (unlike clientWidth) — needed so the canvas fits inside
  // the padded box instead of overflowing it.
  useEffect(() => {
    if (!pdfDoc) return
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    let stale = false

    const renderPage = async (width: number): Promise<void> => {
      try {
        const page = await pdfDoc.getPage(pageNumber)
        if (stale) return
        const unscaled = page.getViewport({ scale: 1 })
        const cssScale = width / unscaled.width
        // Render the backing bitmap at devicePixelRatio so text stays sharp
        // on HiDPI displays, while keeping the on-screen (CSS) size at the
        // fit-to-width scale.
        const dpr = window.devicePixelRatio || 1
        const viewport = page.getViewport({ scale: cssScale * dpr })
        canvas.width = viewport.width
        canvas.height = viewport.height
        canvas.style.width = `${viewport.width / dpr}px`
        canvas.style.height = `${viewport.height / dpr}px`
        const canvasContext = canvas.getContext('2d')
        if (!canvasContext) return
        renderTaskRef.current?.cancel()
        const task = page.render({ canvasContext, canvas, viewport })
        renderTaskRef.current = task
        try {
          await task.promise
        } catch {
          // Cancelled by a subsequent render (page change/resize) — expected.
        }
      } catch {
        // Only treat as a failure if we're not stale (i.e., this is a genuine getPage/render failure).
        if (!stale) setFailed(true)
      }
    }

    const observer = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width
      if (!width) return // Not yet laid out — skip rather than render at scale 0.
      void renderPage(width)
    })
    observer.observe(container)

    return () => {
      stale = true
      observer.disconnect()
      renderTaskRef.current?.cancel()
    }
  }, [pdfDoc, pageNumber])

  if (failed) {
    return <Placeholder title="PDF could not be displayed" detail="Not a valid PDF file" />
  }

  if (!pdfDoc) {
    return <Placeholder title="Loading…" />
  }

  return (
    <div className="pdf-view">
      <div className="pdf-view-scroll" ref={containerRef}>
        <canvas ref={canvasRef} />
      </div>
      {pdfDoc.numPages > 1 && (
        <div className="pdf-view-footer">
          <button
            className="toolbar-button"
            disabled={pageNumber <= 1}
            onClick={() => setPageNumber((p) => p - 1)}
          >
            Prev
          </button>
          <span className="pdf-view-page-count">
            Page {pageNumber} of {pdfDoc.numPages}
          </span>
          <button
            className="toolbar-button"
            disabled={pageNumber >= pdfDoc.numPages}
            onClick={() => setPageNumber((p) => p + 1)}
          >
            Next
          </button>
        </div>
      )}
    </div>
  )
}
