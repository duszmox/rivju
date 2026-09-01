import { app, BrowserWindow } from 'electron'
import { loadCachedPreflight, runPreflight } from './claude/preflight.ts'
import { closeDatabase, openDatabase } from './db/client.ts'
import { applyMigrations, interruptStaleRuns } from './db/migrate.ts'
import { ensureDirs, resolvePaths } from './paths.ts'
import { disposeFakeRuns } from './runs/fake.ts'
import { registerTrpcIpc } from './trpc/ipc.ts'
import type { TrpcContext } from './trpc/context.ts'
import { createMainWindow } from './window.ts'

function bootstrap(): void {
  const paths = resolvePaths()
  ensureDirs(paths)

  const db = openDatabase(paths.dbFile)
  applyMigrations(db, paths.migrationsDir)
  interruptStaleRuns(db)

  const context: TrpcContext = { db }
  registerTrpcIpc(context)

  loadCachedPreflight()
  void runPreflight()
    .then((state) => {
      if (state.status === 'ok') {
        console.log(
          `[rivju] preflight ok: account=${state.account?.email ?? 'unknown'} models=${state.models.length}${state.fromCache ? ' (cached)' : ''}`,
        )
      } else if (state.status === 'failed') {
        console.warn(`[rivju] preflight failed: ${state.reason} — ${state.message}`)
      }
    })
    .catch((err) => {
      console.error('[rivju] preflight crashed', err)
    })

  void createMainWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows().at(0)
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })

  app.whenReady().then(() => {
    try {
      bootstrap()
    } catch (err) {
      console.error('[rivju] bootstrap failed', err)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeFakeRuns()
    closeDatabase()
  })
}
