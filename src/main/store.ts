import Store from 'electron-store'
import type { SidebarMode } from '@shared/types'

interface WindowBounds {
  x?: number
  y?: number
  width: number
  height: number
}

interface StoreSchema {
  recentFolders: string[]
  windowBounds: WindowBounds
  folderModes: Record<string, SidebarMode>
}

const MAX_RECENT = 10

const store = new Store<StoreSchema>({
  defaults: {
    recentFolders: [],
    windowBounds: { width: 1200, height: 800 },
    folderModes: {}
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

export function getFolderMode(root: string): SidebarMode {
  return store.get('folderModes')[root] ?? 'changed'
}

export function setFolderMode(root: string, mode: SidebarMode): void {
  store.set('folderModes', { ...store.get('folderModes'), [root]: mode })
}
