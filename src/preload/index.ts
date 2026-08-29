import { contextBridge, ipcRenderer } from 'electron'
import type {
  FileContent,
  HistoryVersion,
  RepoState,
  SearchResult,
  SidebarMode,
  SymbolLocationsResult
} from '@shared/types'

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, payload: T): void => cb(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api = {
  openFolderDialog: (): Promise<string | null> => ipcRenderer.invoke('dialog:openFolder'),
  openRepo: (root: string): Promise<RepoState> => ipcRenderer.invoke('repo:open', root),
  refreshRepo: (): Promise<RepoState | null> => ipcRenderer.invoke('repo:refresh'),
  setMode: (mode: SidebarMode): Promise<RepoState | null> => ipcRenderer.invoke('mode:set', mode),
  setCustomBaseline: (ref: string | null): Promise<RepoState | null> =>
    ipcRenderer.invoke('baseline:setCustom', ref),
  listRefs: (): Promise<string[]> => ipcRenderer.invoke('git:listRefs'),
  readFile: (absPath: string): Promise<FileContent> => ipcRenderer.invoke('file:read', absPath),
  readBaseFile: (relPath: string): Promise<string> => ipcRenderer.invoke('file:readBase', relPath),
  readResource: (absPath: string): Promise<{ base64: string; mime: string } | null> =>
    ipcRenderer.invoke('file:readResource', absPath),
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('app:recentFolders'),
  copyPath: (absPath: string): void => {
    void ipcRenderer.invoke('app:copyPath', absPath)
  },
  showInFolder: (absPath: string): void => {
    void ipcRenderer.invoke('app:showInFolder', absPath)
  },
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('app:openExternal', url)
  },
  openInBrowser: (absPath: string): void => {
    void ipcRenderer.invoke('app:openInBrowser', absPath)
  },
  onRepoChanged: (cb: (state: RepoState) => void): (() => void) =>
    subscribe('repo:changed', cb),
  onMenuOpenFolder: (cb: (root: string) => void): (() => void) =>
    subscribe('menu:openFolder', cb),
  onMenuOpenFile: (cb: (payload: { root: string; absPath: string }) => void): (() => void) =>
    subscribe('menu:openFile', cb),
  onMenuFindInFiles: (cb: () => void): (() => void) => subscribe<void>('menu:findInFiles', () => cb()),
  onMenuRelatedFiles: (cb: () => void): (() => void) => subscribe<void>('menu:relatedFiles', () => cb()),
  onMenuGoBack: (cb: () => void): (() => void) => subscribe<void>('menu:goBack', () => cb()),
  onMenuGoForward: (cb: () => void): (() => void) => subscribe<void>('menu:goForward', () => cb()),
  onHistoryChanged: (cb: (relPath: string) => void): (() => void) =>
    subscribe('history:changed', cb),
  historyList: (relPath: string): Promise<HistoryVersion[]> =>
    ipcRenderer.invoke('history:list', relPath),
  historyRead: (sha: string): Promise<string> => ipcRenderer.invoke('history:read', sha),
  search: (query: string): Promise<SearchResult> => ipcRenderer.invoke('search:query', query),
  findDefinitions: (word: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('symbol:definitions', word),
  findReferences: (word: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('symbol:references', word),
  findImportedBy: (basename: string): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('related:importedBy', basename),
  findRelatedReferences: (names: string[]): Promise<SymbolLocationsResult> =>
    ipcRenderer.invoke('related:references', names)
}

export type ViewmasterApi = typeof api

contextBridge.exposeInMainWorld('viewmaster', api)
