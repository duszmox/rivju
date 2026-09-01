import { app } from 'electron'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

export interface AppPaths {
  userData: string
  dbFile: string
  logsDir: string
  reposDir: string
  skillsDir: string
  migrationsDir: string
}

/**
 * Resolves every location the app depends on.
 *
 * The generated drizzle migrations are bundled as an app asset: in dev they live
 * at the repo root (`drizzle/`), when packaged electron-builder copies them into
 * `Resources/drizzle` (see `extraResources` in package.json).
 */
export function resolvePaths(): AppPaths {
  const userData = app.getPath('userData')
  return {
    userData,
    dbFile: path.join(userData, 'rivju.db'),
    logsDir: path.join(userData, 'logs'),
    reposDir: path.join(userData, 'repos'),
    skillsDir: path.join(userData, 'skills'),
    migrationsDir: app.isPackaged
      ? path.join(process.resourcesPath, 'drizzle')
      : path.join(__dirname, '../../drizzle'),
  }
}

export function ensureDirs(paths: AppPaths): void {
  mkdirSync(paths.logsDir, { recursive: true })
  mkdirSync(paths.reposDir, { recursive: true })
  mkdirSync(paths.skillsDir, { recursive: true })
}
