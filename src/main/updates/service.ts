import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import { hasLiveReviewRuns } from '../review/runner.ts'
import type { ReleaseChannel } from '../release-channel.ts'

const STARTUP_DELAY_MS = 15_000
const POLL_INTERVAL_MS = 4 * 60_000

export type UpdateStatus =
  | 'disabled'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'downloaded'
  | 'up-to-date'
  | 'error'

export interface UpdateState {
  enabled: boolean
  channel: ReleaseChannel
  currentVersion: string
  status: UpdateStatus
  availableVersion: string | null
  downloadedVersion: string | null
  downloadPercent: number | null
  releaseNotes: string | null
  message: string | null
  checkedAt: string | null
  reviewRunning: boolean
}

let state: UpdateState = {
  enabled: false,
  channel: 'stable',
  currentVersion: '0.0.0',
  status: 'disabled',
  availableVersion: null,
  downloadedVersion: null,
  downloadPercent: null,
  releaseNotes: null,
  message: 'Updates are available only in packaged builds.',
  checkedAt: null,
  reviewRunning: false,
}
let startupTimer: NodeJS.Timeout | null = null
let pollTimer: NodeJS.Timeout | null = null
let configured = false

function updateState(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
}

function releaseNotesText(notes: UpdateInfo['releaseNotes']): string | null {
  if (typeof notes === 'string') return notes.trim() || null
  if (!Array.isArray(notes)) return null
  const text = notes
    .map((item) =>
      `${item.version ? `${item.version}\n` : ''}${item.note ?? ''}`.trim(),
    )
    .filter(Boolean)
    .join('\n\n')
  return text || null
}

function disabledReason(): string | null {
  if (!app.isPackaged) return 'Updates are available only in packaged builds.'
  if (process.platform === 'linux' && !process.env.APPIMAGE) {
    return 'Automatic updates require the AppImage build.'
  }
  return null
}

async function backgroundCheck(reason: string): Promise<void> {
  try {
    await checkForUpdates(reason)
  } catch (error) {
    console.warn(`[rivju] ${reason} update check failed`, error)
  }
}

export function configureUpdates(channel: ReleaseChannel): void {
  if (configured) return
  configured = true
  const reason = disabledReason()
  state = {
    ...state,
    enabled: reason === null,
    channel,
    currentVersion: app.getVersion(),
    status: reason === null ? 'idle' : 'disabled',
    message: reason,
  }
  if (reason) return

  autoUpdater.autoDownload = false
  autoUpdater.autoInstallOnAppQuit = false
  autoUpdater.channel = channel === 'nightly' ? 'nightly' : 'latest'
  autoUpdater.allowPrerelease = channel === 'nightly'
  autoUpdater.allowDowngrade = false
  autoUpdater.fullChangelog = channel === 'nightly'

  autoUpdater.on('checking-for-update', () => {
    updateState({ status: 'checking', message: null })
  })
  autoUpdater.on('update-available', (info) => {
    updateState({
      status: 'available',
      availableVersion: info.version,
      releaseNotes: releaseNotesText(info.releaseNotes),
      message: null,
      checkedAt: new Date().toISOString(),
    })
  })
  autoUpdater.on('update-not-available', () => {
    updateState({
      status: 'up-to-date',
      availableVersion: null,
      releaseNotes: null,
      message: null,
      checkedAt: new Date().toISOString(),
    })
  })
  autoUpdater.on('download-progress', (progress: ProgressInfo) => {
    updateState({
      status: 'downloading',
      downloadPercent: progress.percent,
      message: null,
    })
  })
  autoUpdater.on('update-downloaded', (info) => {
    updateState({
      status: 'downloaded',
      downloadedVersion: info.version,
      downloadPercent: 100,
      message: null,
    })
  })
  autoUpdater.on('error', (error) => {
    updateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  })

  startupTimer = setTimeout(
    () => void backgroundCheck('startup'),
    STARTUP_DELAY_MS,
  )
  startupTimer.unref()
  pollTimer = setInterval(
    () => void backgroundCheck('scheduled'),
    POLL_INTERVAL_MS,
  )
  pollTimer.unref()
}

export function getUpdateState(): UpdateState {
  return { ...state, reviewRunning: hasLiveReviewRuns() }
}

export async function checkForUpdates(reason = 'manual'): Promise<UpdateState> {
  if (!state.enabled) return getUpdateState()
  if (state.status === 'checking' || state.status === 'downloading')
    return getUpdateState()
  console.log(`[rivju] checking for ${state.channel} updates (${reason})`)
  updateState({ status: 'checking', message: null })
  try {
    await autoUpdater.checkForUpdates()
  } catch (error) {
    updateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
      checkedAt: new Date().toISOString(),
    })
  }
  return getUpdateState()
}

export async function downloadUpdate(): Promise<UpdateState> {
  if (!state.enabled) return getUpdateState()
  if (state.status !== 'available' && state.status !== 'error') {
    throw new Error('No update is ready to download')
  }
  updateState({ status: 'downloading', downloadPercent: 0, message: null })
  try {
    await autoUpdater.downloadUpdate()
  } catch (error) {
    updateState({
      status: 'error',
      message: error instanceof Error ? error.message : String(error),
    })
  }
  return getUpdateState()
}

export function installUpdate(): UpdateState {
  if (state.status !== 'downloaded' || !state.downloadedVersion) {
    throw new Error('No downloaded update is ready to install')
  }
  if (hasLiveReviewRuns()) {
    throw new Error(
      'Finish or cancel active reviews before installing the update',
    )
  }
  autoUpdater.quitAndInstall(false, true)
  return getUpdateState()
}

export function disposeUpdates(): void {
  if (startupTimer) clearTimeout(startupTimer)
  if (pollTimer) clearInterval(pollTimer)
  startupTimer = null
  pollTimer = null
}
