import { contextBridge } from 'electron'

// Filled in with the real API in the preload-bridge task.
contextBridge.exposeInMainWorld('viewmaster', {})
