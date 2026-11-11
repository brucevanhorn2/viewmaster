import { useEffect, useState } from 'react'
import { subscribeNotice, type SymbolNotice } from '../navigation/symbolNotice'

const SHORT_MS = 4000
const LONG_MS = 8000

export default function StatusNotice(): React.JSX.Element | null {
  const [notice, setNotice] = useState<SymbolNotice | null>(null)

  useEffect(() => subscribeNotice(setNotice), [])

  // Depending on the notice object restarts the timer on every newer notice.
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), notice.hint ? LONG_MS : SHORT_MS)
    return () => window.clearTimeout(id)
  }, [notice])

  if (!notice) return null
  return (
    <div className="status-notice" role="status">
      <div className="status-notice-text">{notice.text}</div>
      {notice.hint && <code className="status-notice-hint">{notice.hint}</code>}
    </div>
  )
}
