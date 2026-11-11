import type { ApproximateReason, LspLanguage, SymbolLocationsResult } from '@shared/types'

export interface SymbolNotice {
  text: string
  hint: string | null
}

type Approx = { language: LspLanguage; reason: ApproximateReason }

const GO_INSTALL_HINT = 'go install golang.org/x/tools/gopls@latest'

export function noticeText(a: Approx): string {
  const lang = a.language === 'go' ? 'Go' : 'Python'
  if (a.reason === 'starting') return `approximate — ${lang} index still loading`
  // Python is bundled, so it never reports "not installed"; map it to "unavailable".
  if (a.reason === 'not-installed' && a.language === 'go') return 'approximate — gopls not installed'
  return `approximate — ${lang} language server unavailable`
}

export function installHint(a: Approx): string | null {
  return a.language === 'go' && a.reason === 'not-installed' ? GO_INSTALL_HINT : null
}

const listeners = new Set<(n: SymbolNotice | null) => void>()
// The install hint is shown at most once per app session.
let hintShown = false

export function subscribeNotice(cb: (n: SymbolNotice | null) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function reportResult(r: SymbolLocationsResult): void {
  if (r.source === 'lsp') {
    // A real answer: an earlier "approximate" notice no longer applies.
    for (const cb of [...listeners]) cb(null)
    return
  }
  if (!r.approximate) return
  let hint = installHint(r.approximate)
  if (hint) {
    if (hintShown) hint = null
    // Only counts as shown once someone actually received it.
    else if (listeners.size > 0) hintShown = true
  }
  const notice: SymbolNotice = { text: noticeText(r.approximate), hint }
  for (const cb of [...listeners]) cb(notice)
}

/** Test-only: forget that the install hint was already shown. */
export function resetNoticeStateForTests(): void {
  hintShown = false
}
