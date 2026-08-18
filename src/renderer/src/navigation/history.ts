export type NavigationTarget = { kind: 'anchor'; id: string } | { kind: 'line'; line: number }

export interface NavigationEntry {
  absPath: string
  target?: NavigationTarget
}

export interface NavigationState {
  entries: NavigationEntry[]
  index: number
}

export function initialNavigationState(): NavigationState {
  return { entries: [], index: -1 }
}

/** Pushes a new entry, discarding any "forward" entries past the current position. */
export function pushEntry(state: NavigationState, entry: NavigationEntry): NavigationState {
  const kept = state.entries.slice(0, state.index + 1)
  return { entries: [...kept, entry], index: kept.length }
}

export function canGoBack(state: NavigationState): boolean {
  return state.index > 0
}

export function canGoForward(state: NavigationState): boolean {
  return state.index < state.entries.length - 1
}

export function goBack(state: NavigationState): NavigationState {
  return canGoBack(state) ? { ...state, index: state.index - 1 } : state
}

export function goForward(state: NavigationState): NavigationState {
  return canGoForward(state) ? { ...state, index: state.index + 1 } : state
}

export function currentEntry(state: NavigationState): NavigationEntry | null {
  return state.entries[state.index] ?? null
}
