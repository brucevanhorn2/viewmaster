/**
 * Extracts the first path-like argument from `argv`, skipping Electron's
 * own leading arguments (the packaged app's own executable path, or in
 * dev mode both the electron binary and the entry-point/project-dir arg)
 * and any flag-like arguments (starting with `-`, e.g. Chromium/Electron
 * flags or macOS's `-psn_...` process-serial-number arg passed on a
 * Finder-launched app). Returns null if nothing qualifies.
 */
export function getPathArgFromArgv(argv: string[], isPackaged: boolean): string | null {
  const userArgs = argv.slice(isPackaged ? 1 : 2)
  return userArgs.find((arg) => !arg.startsWith('-')) ?? null
}
