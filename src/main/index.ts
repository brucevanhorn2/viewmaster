import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { join } from 'path'
import { registerIpc, disposeIpc } from './ipc'
import { getRecentFolders, getWindowBounds, setWindowBounds } from './store'

function sendOpenFolder(win: BrowserWindow, root: string): void {
  win.webContents.send('menu:openFolder', root)
}

async function pickFolder(win: BrowserWindow): Promise<void> {
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (!result.canceled && result.filePaths.length > 0) {
    sendOpenFolder(win, result.filePaths[0])
  }
}

function buildMenu(win: BrowserWindow): void {
  const recents = getRecentFolders()
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickFolder(win)
        },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? recents.map((root) => ({ label: root, click: () => sendOpenFolder(win, root) }))
            : [{ label: 'No Recent Folders', enabled: false }]
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): BrowserWindow {
  const bounds = getWindowBounds()
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 600,
    minHeight: 400,
    backgroundColor: '#1e1e1e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  const saveBounds = (): void => {
    if (!win.isDestroyed() && !win.isMinimized()) setWindowBounds(win.getBounds())
  }
  win.on('resized', saveBounds)
  win.on('moved', saveBounds)
  win.on('close', saveBounds)

  // Never open new windows; anything targeting one goes to the default browser.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Dev/testing hook: auto-open a folder on launch.
  const autoOpen = process.env['VIEWMASTER_OPEN']
  if (autoOpen) {
    win.webContents.on('did-finish-load', () => sendOpenFolder(win, autoOpen))
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  const win = createWindow()
  // Rebuild the menu when a repo opens so the recent-folders submenu stays fresh.
  registerIpc(win, () => buildMenu(win))
  buildMenu(win)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void disposeIpc()
  if (process.platform !== 'darwin') app.quit()
})
