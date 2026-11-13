import { useCallback, useState } from 'react'

/**
 * Per-file "load remote images" allowance. `allowed` is true only after
 * `allow()` was called for the current absPath; any absPath change (another
 * file, Back/Forward, link navigation) resets it to blocked, even if the same
 * path is returned to later. State is adjusted during render (no effect), so
 * there is never a frame where a new file inherits the previous allowance.
 */
export function useRemoteAllowance(absPath: string | null): [boolean, () => void] {
  const [state, setState] = useState<{ path: string | null; allowed: boolean }>({
    path: absPath,
    allowed: false
  })
  let allowed = state.allowed
  if (state.path !== absPath) {
    setState({ path: absPath, allowed: false })
    allowed = false
  }
  const allow = useCallback(() => setState({ path: absPath, allowed: true }), [absPath])
  return [allowed && absPath !== null, allow]
}
