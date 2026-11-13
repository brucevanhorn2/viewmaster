import { useEffect, useState } from 'react'
import { subscribeNotice } from '../navigation/symbolNotice'
import { nextNotice, type ShownNotice } from './statusNoticeState'

export default function StatusNotice(): React.JSX.Element | null {
  const [shown, setShown] = useState<ShownNotice | null>(null)

  useEffect(
    () =>
      subscribeNotice((n) => {
        const now = Date.now() // read outside the updater so it stays pure
        setShown((cur) => nextNotice(cur, n, now))
      }),
    []
  )

  // Keyed on the deadline: a newer notice restarts the timer, but a text
  // update that keeps a showing install hint does not shorten (or extend) it.
  const until = shown?.until
  useEffect(() => {
    if (until === undefined) return
    const id = window.setTimeout(() => setShown(null), Math.max(0, until - Date.now()))
    return () => window.clearTimeout(id)
  }, [until])

  if (!shown) return null
  const { notice } = shown
  return (
    <div className="status-notice" role="status">
      <div className="status-notice-text">{notice.text}</div>
      {notice.hint && <code className="status-notice-hint">{notice.hint}</code>}
    </div>
  )
}
