import { app } from 'electron'
import { readFileSync } from 'node:fs'
import path from 'node:path'

export type ReleaseChannel = 'stable' | 'nightly'

interface PackageMetadata {
  rivjuChannel?: unknown
}

export function parseReleaseChannel(metadata: PackageMetadata): ReleaseChannel {
  return metadata.rivjuChannel === 'nightly' ? 'nightly' : 'stable'
}

export function getReleaseChannel(): ReleaseChannel {
  if (!app.isPackaged) return 'stable'
  try {
    const raw = readFileSync(
      path.join(app.getAppPath(), 'package.json'),
      'utf8',
    )
    return parseReleaseChannel(JSON.parse(raw) as PackageMetadata)
  } catch (error) {
    console.warn(
      '[rivju] could not read packaged release channel; using stable',
      error,
    )
    return 'stable'
  }
}

export function configureReleaseIdentity(channel: ReleaseChannel): void {
  if (channel !== 'nightly') return
  app.setName('rivju Nightly')
  if (!process.env.RIVJU_USER_DATA_DIR) {
    app.setPath('userData', path.join(app.getPath('appData'), 'rivju-nightly'))
  }
}
