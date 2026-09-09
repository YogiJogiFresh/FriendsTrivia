import path from 'node:path'

import { app, BrowserWindow, dialog, shell } from 'electron'
import { autoUpdater } from 'electron-updater'

const isDevelopment = !app.isPackaged
const port = Number(process.env.FRIENDS_TRIVIA_PORT ?? 3000)
let mainWindow: BrowserWindow | null = null
let server: { close(): Promise<void> } | null = null

function createWindow(url: string): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 850,
    minWidth: 900,
    minHeight: 650,
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  window.webContents.setWindowOpenHandler(({ url: targetUrl }) => {
    const target = new URL(targetUrl)
    const appUrl = new URL(url)
    if (target.origin === appUrl.origin) {
      createWindow(targetUrl)
    } else {
      void shell.openExternal(targetUrl)
    }
    return { action: 'deny' }
  })
  void window.loadURL(url)
  return window
}

async function startServer(): Promise<string> {
  if (isDevelopment) return 'http://localhost:5173'

  const userData = app.getPath('userData')
  process.env.APP_ROOT = process.resourcesPath
  process.env.DATABASE_PATH = path.join(userData, 'data', 'friends-trivia.db')
  process.env.CONTENT_ROOT = path.join(userData, 'content')
  process.env.WEB_DIST = path.join(process.resourcesPath, 'web')
  process.env.HOST = '0.0.0.0'
  process.env.PORT = String(port)

  const { buildApp } = await import('../../server/src/app.js')
  const built = await buildApp()
  server = built.app
  await built.app.listen({ host: '0.0.0.0', port })
  return `http://127.0.0.1:${port}`
}

function setupAutoUpdater(): void {
  if (isDevelopment) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = true

  autoUpdater.on('update-available', ({ version }) => {
    if (!mainWindow) return
    void dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Available',
        message: `FriendsTrivia ${version} is available.`,
        detail: 'Would you like to download it now?',
        buttons: ['Download', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response !== 0) return
        void autoUpdater.downloadUpdate().catch((error: Error) => {
          if (!mainWindow) return
          void dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Download Failed',
            message: 'FriendsTrivia could not download the update.',
            detail: error.message,
          })
        })
      })
  })

  autoUpdater.on('download-progress', ({ percent }) => {
    mainWindow?.setProgressBar(percent / 100)
  })

  autoUpdater.on('update-downloaded', () => {
    mainWindow?.setProgressBar(-1)
    if (!mainWindow) return
    void dialog
      .showMessageBox(mainWindow, {
        type: 'info',
        title: 'Update Ready',
        message: 'The FriendsTrivia update is ready to install.',
        buttons: ['Restart Now', 'Later'],
        defaultId: 0,
        cancelId: 1,
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall()
      })
  })

  autoUpdater.on('error', (error) => {
    mainWindow?.setProgressBar(-1)
    console.error('Auto-updater error:', error.message)
  })

  void autoUpdater.checkForUpdates().catch((error: Error) => {
    console.error('Update check failed:', error.message)
  })
}

const hasSingleInstanceLock = app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (!mainWindow) return
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    try {
      const url = await startServer()
      mainWindow = createWindow(url)
      mainWindow.on('closed', () => {
        mainWindow = null
      })
      setupAutoUpdater()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown startup error'
      await dialog.showMessageBox({
        type: 'error',
        title: 'FriendsTrivia Could Not Start',
        message: 'The local game server could not be started.',
        detail: message,
      })
      app.quit()
    }
  })
}

app.on('before-quit', () => {
  if (server) void server.close()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
