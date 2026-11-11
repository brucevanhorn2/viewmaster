import { useCallback, useEffect, useRef, useState } from 'react'
import Placeholder from './Placeholder'
import { attachPanZoom, type PanZoomController } from '../image/panZoom'
import type { PanZoomState } from '../image/panZoomMath'

export default function ImageView({
  src,
  resetKey
}: {
  src: string
  resetKey: string
}): React.JSX.Element {
  const [failed, setFailed] = useState(false)
  const viewportRef = useRef<HTMLDivElement>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const ctrlRef = useRef<PanZoomController | null>(null)
  const attachedKeyRef = useRef<string>(resetKey)
  const savedRef = useRef<{ key: string; state: PanZoomState } | null>(null)
  const resetKeyRef = useRef(resetKey)
  resetKeyRef.current = resetKey

  const detach = useCallback((): void => {
    const ctrl = ctrlRef.current
    if (!ctrl) return
    savedRef.current = { key: attachedKeyRef.current, state: ctrl.getState() }
    ctrl.destroy()
    ctrlRef.current = null
  }, [])

  useEffect(() => {
    setFailed(false)
    return detach
  }, [src, detach])

  const onLoad = useCallback((): void => {
    const viewport = viewportRef.current
    const img = imgRef.current
    if (!viewport || !img) return
    detach()
    let natural = { width: img.naturalWidth, height: img.naturalHeight }
    if (!natural.width || !natural.height) {
      const r = img.getBoundingClientRect()
      natural = { width: r.width, height: r.height }
    }
    if (!natural.width || !natural.height) return // cannot attach: keep the plain look
    const key = resetKeyRef.current
    const saved = savedRef.current
    const initial = saved && saved.key === key ? saved.state : undefined
    attachedKeyRef.current = key
    ctrlRef.current = attachPanZoom(viewport, img, {
      natural,
      wheelPans: true,
      controlsOnHover: false,
      initial
    })
  }, [detach])

  if (failed) {
    return <Placeholder title="Image could not be displayed" detail="Not a valid image file" />
  }

  return (
    <div className="image-view" ref={viewportRef}>
      <img
        ref={imgRef}
        src={src}
        alt=""
        onLoad={onLoad}
        onError={() => {
          detach()
          setFailed(true)
        }}
      />
    </div>
  )
}
