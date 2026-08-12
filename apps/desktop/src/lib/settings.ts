import type { CommitIdentity } from '@dukebox/protocol'
import { load, type Store } from '@tauri-apps/plugin-store'

/**
 * App preferences, kept apart from connections.
 *
 * Connections are credentials and get the keychain-grade storage in
 * `connection.ts`; these are ordinary preferences — a theme, a launch
 * behaviour, an identity — so they live in a plain store file instead.
 *
 * The theme is mirrored into localStorage as a side effect. Reading a store
 * file is asynchronous, and a window that paints in the wrong scheme for a
 * hundred milliseconds looks broken; the mirror is what lets `main.tsx` apply
 * the saved theme synchronously before anything renders.
 */

export type Theme = 'system' | 'light' | 'dark'

export interface Settings {
  /** How the app picks its colour scheme. `system` follows the OS. */
  theme: Theme
  /** Whether launching asks the release feed for a newer build. */
  checkForUpdatesOnLaunch: boolean
  /**
   * Who commits are authored as, sent with every new session.
   *
   * Null means the default identity — the fallback this becomes once a
   * person configures their own.
   */
  commitIdentity: CommitIdentity | null
}

export function defaultSettings(): Settings {
  return {
    theme: 'system',
    checkForUpdatesOnLaunch: true,
    commitIdentity: null,
  }
}

const STORE_FILE = 'settings.json'
const SETTINGS_KEY = 'settings'
/** Same value the store file holds, so a render can read it synchronously. */
const THEME_MIRROR_KEY = 'dukebox.theme'

let store: Store | undefined

async function open(): Promise<Store> {
  store ??= await load(STORE_FILE, { autoSave: true })
  return store
}

export async function loadSettings(): Promise<Settings> {
  const saved = await (await open()).get<Settings>(SETTINGS_KEY)
  return { ...defaultSettings(), ...saved }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch }
  await (await open()).set(SETTINGS_KEY, next)

  // The theme mirror follows every save that touches the theme, so a reboot
  // after changing it applies the new scheme without a flash.
  if (patch.theme !== undefined) {
    localStorage.setItem(THEME_MIRROR_KEY, next.theme)
  }

  await (await open()).save()
  return next
}

/**
 * Apply the saved theme synchronously, before React mounts.
 *
 * `system` removes the attribute so the `prefers-color-scheme` rules in
 * `styles.css` decide; the explicit schemes pin the `data-theme` selectors.
 */
export function applyTheme(theme: Theme): void {
  const root = document.documentElement

  if (theme === 'system') {
    root.removeAttribute('data-theme')
  } else {
    root.setAttribute('data-theme', theme)
  }
}

/** The theme saved by a previous run, for the synchronous boot path. */
export function bootTheme(): Theme {
  const mirror = localStorage.getItem(THEME_MIRROR_KEY)
  return mirror === 'light' || mirror === 'dark' ? mirror : 'system'
}
