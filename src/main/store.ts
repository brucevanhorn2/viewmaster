import Store from 'electron-store'

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface StoreSchema {
  recentFolders: string[]
  windowBounds: WindowBounds
}

const MAX_RECENT = 10

const store = new Store<StoreSchema>({
  defaults: {
    recentFolders: [],
    windowBounds: { width: 1200, height: 800 }
  }
})

export function getRecentFolders(): string[] {
  return store.get('recentFolders')
}

export function addRecentFolder(root: string): void {
  const recents = store.get('recentFolders').filter((r) => r !== root)
  recents.unshift(root)
  store.set('recentFolders', recents.slice(0, MAX_RECENT))
}

export function getWindowBounds(): WindowBounds {
  return store.get('windowBounds')
}

export function setWindowBounds(bounds: WindowBounds): void {
  store.set('windowBounds', bounds)
}
