/** The slice of Electron's `app` this needs (an EventEmitter with quit()). */
export interface QuittableApp {
  on(event: 'will-quit', listener: (event: { preventDefault(): void }) => void): unknown
  quit(): void
}

/**
 * app.quit() / Cmd+Q / menu Quit do not emit window-all-closed, so language
 * server children (issue #22) would otherwise outlive the app. Hold the first
 * quit until `dispose` settles, then quit again — once.
 *
 * The re-quit is deferred with setImmediate: when `dispose` settles at once
 * (no server running, the common case), a quit() from the promise callback
 * still lands inside the quit cycle that was just preventDefault'ed, and
 * Electron ignores it — the process then never exits. Waiting for the next
 * event-loop turn lets that cycle finish first.
 */
/** Longest a quit waits on dispose before quitting anyway. */
export const QUIT_DISPOSE_BOUND_MS = 6000

export function installQuitDisposal(
  app: QuittableApp,
  dispose: () => Promise<void>,
  boundMs: number = QUIT_DISPOSE_BOUND_MS
): void {
  let disposed = false
  app.on('will-quit', (event) => {
    if (disposed) return
    event.preventDefault()
    disposed = true
    // Bounded, so a dispose that never settles cannot keep the app alive.
    let timer: NodeJS.Timeout | undefined
    void Promise.race([dispose(), new Promise<void>((r) => (timer = setTimeout(r, boundMs)))])
      .catch(() => {})
      .finally(() => {
        clearTimeout(timer)
        setImmediate(() => app.quit())
      })
  })
}
