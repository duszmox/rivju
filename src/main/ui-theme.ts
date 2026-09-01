import { nativeTheme } from 'electron'
import { UI_THEME_KEY, readSetting, writeSetting } from './settings/service.ts'

/**
 * Appearance preference: follow the OS, or pin light/dark. Persisted in the
 * `setting` table and applied through Electron's `nativeTheme.themeSource`,
 * which drives the renderer's `prefers-color-scheme` media query — so the
 * renderer needs no IPC to know which palette to paint.
 */

export type UiTheme = 'system' | 'light' | 'dark'

const THEMES: readonly UiTheme[] = ['system', 'light', 'dark']

export function getUiTheme(): UiTheme {
  const stored = readSetting(UI_THEME_KEY)
  return THEMES.includes(stored as UiTheme) ? (stored as UiTheme) : 'system'
}

/** Must run before the first window is created so first paint uses it. */
export function applyUiTheme(theme: UiTheme): void {
  nativeTheme.themeSource = theme
}

export function setUiTheme(theme: UiTheme): UiTheme {
  writeSetting(UI_THEME_KEY, theme)
  applyUiTheme(theme)
  return theme
}
