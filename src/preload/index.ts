import { contextBridge, ipcRenderer } from 'electron'
import type { FileContent, HistoryVersion, RepoState, SidebarMode } from '@shared/types'

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
  readFile: (absPath: string): Promise<FileContent> => ipcRenderer.invoke('file:read', absPath),
  readBaseFile: (relPath: string): Promise<string> => ipcRenderer.invoke('file:readBase', relPath),
  recentFolders: (): Promise<string[]> => ipcRenderer.invoke('app:recentFolders'),
  copyPath: (absPath: string): void => {
    void ipcRenderer.invoke('app:copyPath', absPath)
  },
  openExternal: (url: string): void => {
    void ipcRenderer.invoke('app:openExternal', url)
  },
  onRepoChanged: (cb: (state: RepoState) => void): (() => void) =>
    subscribe('repo:changed', cb),
  onMenuOpenFolder: (cb: (root: string) => void): (() => void) =>
    subscribe('menu:openFolder', cb),
  onHistoryChanged: (cb: (relPath: string) => void): (() => void) =>
    subscribe('history:changed', cb),
  historyList: (relPath: string): Promise<HistoryVersion[]> =>
    ipcRenderer.invoke('history:list', relPath),
  historyRead: (sha: string): Promise<string> => ipcRenderer.invoke('history:read', sha)
}

export type ViewmasterApi = typeof api

contextBridge.exposeInMainWorld('viewmaster', api)
