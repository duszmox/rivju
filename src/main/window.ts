import { app, BrowserWindow, shell } from 'electron'
import path from 'node:path'

export async function createMainWindow(): Promise<BrowserWindow> {
  const win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 600,
    show: false,
    title: 'rivju',
    backgroundColor: '#e7f3ec',
    webPreferences: {
      // Preload is bundled to out/preload/index.cjs (CommonJS).
      preload: path.join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      // Kept unsandboxed so the preload can use Node APIs later if needed;
      // contextIsolation stays on and the renderer still has no Node access.
      sandbox: false,
    },
  })

  win.on('ready-to-show', () => win.show())

  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env.ELECTRON_RENDERER_URL
  if (!app.isPackaged && devServerUrl) {
    await win.loadURL(devServerUrl)
  } else {
    await win.loadFile(path.join(__dirname, '../renderer/index.html'))
  }

  return win
}
