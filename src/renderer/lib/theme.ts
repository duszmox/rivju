import { useEffect, useState } from 'react'

const QUERY = '(prefers-color-scheme: dark)'

/**
 * Electron maps the main process's `nativeTheme.themeSource` onto this
 * renderer's `prefers-color-scheme` media query, so the query alone covers
 * system / light / dark with no IPC. The `.dark` class on <html> activates
 * the dark palette in styles.css (see `@custom-variant dark`).
 */

function applyClass(): void {
  document.documentElement.classList.toggle('dark', window.matchMedia(QUERY).matches)
}

/** Runs before React mounts so the first paint already has the right theme. */
export function initTheme(): void {
  applyClass()
  window.matchMedia(QUERY).addEventListener('change', applyClass)
}

/** Reactive boolean for logic that must re-render on theme change. */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => window.matchMedia(QUERY).matches)
  useEffect(() => {
    const media = window.matchMedia(QUERY)
    const update = (): void => setDark(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
  return dark
}
