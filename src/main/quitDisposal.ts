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
export function installQuitDisposal(app: QuittableApp, dispose: () => Promise<void>): void {
  let disposed = false
  app.on('will-quit', (event) => {
    if (disposed) return
    event.preventDefault()
    disposed = true
    void dispose()
      .catch(() => {})
      .finally(() => setImmediate(() => app.quit()))
  })
}
