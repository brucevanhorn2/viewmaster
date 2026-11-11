import type { SymbolNotice } from '../navigation/symbolNotice'

export const SHORT_MS = 4000
export const LONG_MS = 8000

export interface ShownNotice {
  notice: SymbolNotice
  /** Epoch ms at which the notice is hidden. */
  until: number
}

/**
 * What StatusNotice shows after `incoming` arrives at `now`. A notice carrying
 * the install hint (shown once per app session) is not displaced by a later
 * hint-less notice before its own LONG_MS elapse: the text updates, the hint
 * and deadline stay.
 */
export function nextNotice(
  current: ShownNotice | null,
  incoming: SymbolNotice | null,
  now: number
): ShownNotice | null {
  if (!incoming) return null
  if (current?.notice.hint && !incoming.hint && now < current.until) {
    return { notice: { text: incoming.text, hint: current.notice.hint }, until: current.until }
  }
  return { notice: incoming, until: now + (incoming.hint ? LONG_MS : SHORT_MS) }
}
