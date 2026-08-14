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
  useEffect(() => {
    let stale = false
    setFailed(false)
    setPdfDoc(null)
    setPageNumber(1)
    const task = getDocument({ data: base64ToBytes(base64) })
    task.promise.then(
      (doc) => {
        if (!stale) setPdfDoc(doc)
      },
      () => {
        if (!stale) setFailed(true)
      }
    )
    return () => {
      stale = true
      void task.destroy()
    }
  }, [base64])

  // Render the current page at a scale that fits the container's width.
  // A ResizeObserver fires once immediately on observe() (in addition to on
  // actual resizes), so this alone drives both the initial render and
  // re-renders on pane/window resize — no separate initial-render call needed.
  useEffect(() => {
    if (!pdfDoc) return
    const container = containerRef.current
    const canvas = canvasRef.current
    if (!container || !canvas) return

    let stale = false

    const renderPage = async (): Promise<void> => {
      const page = await pdfDoc.getPage(pageNumber)
      if (stale) return
      const unscaled = page.getViewport({ scale: 1 })
      const scale = container.clientWidth / unscaled.width
      const viewport = page.getViewport({ scale })
      canvas.width = viewport.width
      canvas.height = viewport.height
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
    }

    const observer = new ResizeObserver(() => void renderPage())
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
