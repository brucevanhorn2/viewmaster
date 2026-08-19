import { app, BrowserWindow, Menu, dialog, shell } from 'electron'
import { join } from 'path'
import { registerIpc, disposeIpc } from './ipc'
import { getRecentFolders, getWindowBounds, setWindowBounds } from './store'
import icon from '../../resources/icon.png?asset'

// The single app window. Resolved at *use* time everywhere (menu clicks,
// watcher pushes, dialogs) — capturing a BrowserWindow in a closure goes
// stale when the window is closed and recreated via macOS `activate`,
// which silently killed auto-refresh in recreated windows.
let mainWindow: BrowserWindow | null = null

function getMainWindow(): BrowserWindow | null {
  return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
}

function sendOpenFolder(root: string): void {
  getMainWindow()?.webContents.send('menu:openFolder', root)
}

function sendFindInFiles(): void {
  getMainWindow()?.webContents.send('menu:findInFiles')
}

function sendRelatedFiles(): void {
  getMainWindow()?.webContents.send('menu:relatedFiles')
}

function sendGoBack(): void {
  getMainWindow()?.webContents.send('menu:goBack')
}

function sendGoForward(): void {
  getMainWindow()?.webContents.send('menu:goForward')
}

async function pickFolder(): Promise<void> {
  const win = getMainWindow()
  if (!win) return
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
  if (!result.canceled && result.filePaths.length > 0) {
    sendOpenFolder(result.filePaths[0])
  }
}

function buildMenu(): void {
  const recents = getRecentFolders()
  const template: Electron.MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' as const }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Folder…',
          accelerator: 'CmdOrCtrl+O',
          click: () => void pickFolder()
        },
        {
          label: 'Open Recent',
          submenu: recents.length
            ? recents.map((root) => ({ label: root, click: () => sendOpenFolder(root) }))
            : [{ label: 'No Recent Folders', enabled: false }]
        },
        { type: 'separator' },
        process.platform === 'darwin' ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Search',
      submenu: [
        {
          label: 'Find in Files…',
          accelerator: 'CmdOrCtrl+Shift+F',
          click: () => sendFindInFiles()
        },
        {
          label: 'Related Files…',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => sendRelatedFiles()
        }
      ]
    },
    {
      label: 'Go',
      submenu: [
        {
          label: 'Back',
          accelerator: process.platform === 'darwin' ? 'Cmd+[' : 'Alt+Left',
          click: () => sendGoBack()
        },
        {
          label: 'Forward',
          accelerator: process.platform === 'darwin' ? 'Cmd+]' : 'Alt+Right',
          click: () => sendGoForward()
        }
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
    // macOS ignores this and uses the app bundle / dock icon (set below);
    // Linux and Windows take the window icon from here.
    ...(process.platform !== 'darwin' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow = win
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
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

  // Hard boundary against previewed content (e.g. a <form> in a rendered
  // HTML file) navigating the app window itself away from its own loaded
  // URL — that would otherwise inherit the full preload IPC bridge. Holds
  // even if the sanitizer allowlist ever regresses to permit some other
  // navigation vector.
  win.webContents.on('will-navigate', (event, url) => {
    if (url !== win.webContents.getURL()) event.preventDefault()
  })

  // Dev/testing hook: auto-open a folder on launch.
  const autoOpen = process.env['VIEWMASTER_OPEN']
  if (autoOpen) {
    win.webContents.on('did-finish-load', () => sendOpenFolder(autoOpen))
  }

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

app.whenReady().then(() => {
  // Show the icon in the macOS dock during `npm run dev` — the dev process runs
  // bare Electron. Packaged builds get it from the app bundle (electron-builder
  // generates the icns from resources/icon.png), and resources/ isn't shipped
  // inside the package, so only do this unpackaged to avoid a missing-file path.
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(icon)
  createWindow()
  // Rebuild the menu when a repo opens so the recent-folders submenu stays fresh.
  registerIpc(getMainWindow, () => buildMenu())
  buildMenu()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  void disposeIpc()
  if (process.platform !== 'darwin') app.quit()
})
