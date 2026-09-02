import { app, BrowserWindow } from 'electron'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { loadCachedPreflight, runPreflight } from './claude/preflight.ts'
import { closeDatabase, openDatabase } from './db/client.ts'
import { applyMigrations, interruptStaleRuns } from './db/migrate.ts'
import { ensureDirs, resolvePaths } from './paths.ts'
import { runRepoGc } from './repo/service.ts'
import { disposeReviewRuns } from './review/runner.ts'
import {
  configureReleaseIdentity,
  getReleaseChannel,
} from './release-channel.ts'
import { seedBuiltinSkills } from './skills/seed.ts'
import { applyUiTheme, getUiTheme } from './ui-theme.ts'
import { registerTrpcIpc } from './trpc/ipc.ts'
import type { TrpcContext } from './trpc/context.ts'
import { createMainWindow } from './window.ts'
import { configureUpdates, disposeUpdates } from './updates/service.ts'

const releaseChannel = getReleaseChannel()
configureReleaseIdentity(releaseChannel)

async function bootstrap(): Promise<void> {
  // Packaged mac builds take the dock icon from the bundled icon.icns; in dev
  // we are running the stock Electron binary, so set it explicitly.
  if (!app.isPackaged && process.platform === 'darwin' && app.dock) {
    const devIcon = path.join(app.getAppPath(), 'build', 'icon.png')
    if (existsSync(devIcon)) {
      try {
        app.dock.setIcon(devIcon)
      } catch (err) {
        console.warn('[rivju] dock icon failed', err)
      }
    }
  }

  const paths = resolvePaths()
  ensureDirs(paths)

  const db = openDatabase(paths.dbFile)
  await applyMigrations(db, paths.migrationsDir, paths.dbBackupsDir)
  interruptStaleRuns(db)
  await seedBuiltinSkills(db, paths.skillsDir)
  await runRepoGc()
    .then(({ removed }) => {
      if (removed > 0)
        console.log(`[rivju] removed ${removed} orphaned/expired worktree(s)`)
    })
    .catch((err) =>
      console.warn('[rivju] repository cache cleanup failed', err),
    )

  const context: TrpcContext = { db }
  registerTrpcIpc(context)

  // Before the window exists so first paint uses the persisted appearance.
  applyUiTheme(getUiTheme())

  loadCachedPreflight()
  void runPreflight()
    .then((state) => {
      if (state.status === 'ok') {
        console.log(
          `[rivju] preflight ok: account=${state.account?.email ?? 'unknown'} models=${state.models.length}${state.fromCache ? ' (cached)' : ''}`,
        )
      } else if (state.status === 'failed') {
        console.warn(
          `[rivju] preflight failed: ${state.reason} — ${state.message}`,
        )
      }
    })
    .catch((err) => {
      console.error('[rivju] preflight crashed', err)
    })

  void createMainWindow()
  configureUpdates(releaseChannel)

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void createMainWindow()
  })
}

const gotSingleInstanceLock = app.requestSingleInstanceLock()

/**
 * Hermetic test/dev support: point the whole app at an isolated data
 * directory. Playwright's Electron launch sets this so a smoke test never
 * touches the user's real rivju data. Playwright's loader also force-appends
 * `--password-store=basic`, which disables safeStorage on Linux entirely —
 * re-append the real keyring backend so token encryption works under test.
 */
if (gotSingleInstanceLock) {
  const isolatedData = process.env.RIVJU_USER_DATA_DIR
  if (isolatedData) {
    app.setPath('userData', isolatedData)
    if (process.platform === 'linux') {
      app.commandLine.appendSwitch('password-store', 'gnome-libsecret')
    }
  }
}

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

  app.whenReady().then(async () => {
    try {
      await bootstrap()
    } catch (err) {
      console.error('[rivju] bootstrap failed', err)
      app.quit()
    }
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    disposeUpdates()
    disposeReviewRuns()
    closeDatabase()
  })
}
