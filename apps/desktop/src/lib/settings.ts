import type {
  CommitIdentity,
  GitPreferences,
  ProjectSummary,
  SessionSummary,
} from '@dukebox/protocol'
import { DEFAULT_GIT_PREFERENCES } from '@dukebox/protocol'
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
   * Desktop notification when a session transitions to `waiting_input`.
   *
   * The protocol already treats that status as the alert; this is the switch
   * for whether this device should fire it.
   */
  notifyWhenWaiting: boolean
  /**
   * Who commits are authored as, sent with every new session.
   *
   * Null means the default identity — the fallback this becomes once a
   * person configures their own.
   */
  commitIdentity: CommitIdentity | null
  /** How new sessions commit, open, and merge pull requests. */
  git: GitPreferences
  /**
   * The New Session pickers as they were when the last session started.
   *
   * Null until the first session is created from this app. The form falls
   * back to the most recent session on the server when this is absent.
   */
  lastNewSession: LastNewSession | null
}

/**
 * Choices above the New Session prompt, remembered across opens.
 *
 * `environmentId` is empty for the base image. `providerId` is empty unless
 * the agent was OpenCode. `model` may be empty when this was derived from a
 * session summary, which does not carry one.
 */
export interface LastNewSession {
  repoFullName: string
  baseBranch: string
  environmentId: string
  agentId: string
  model: string
  providerId: string
  permissionMode: string
}

export function defaultSettings(): Settings {
  return {
    theme: 'system',
    checkForUpdatesOnLaunch: true,
    notifyWhenWaiting: true,
    commitIdentity: null,
    git: DEFAULT_GIT_PREFERENCES,
    lastNewSession: null,
  }
}

/** Fill the form from a session row when nothing has been saved locally yet. */
export function lastNewSessionFromSummary(
  session: SessionSummary | undefined,
  projects: ProjectSummary[],
): LastNewSession | null {
  if (!session) return null
  const project = projects.find((candidate) => candidate.id === session.projectId)
  if (!project) return null
  return {
    repoFullName: project.repoFullName,
    baseBranch: session.baseBranch,
    environmentId: session.environmentId ?? '',
    agentId: session.agentId,
    model: '',
    providerId: '',
    permissionMode: session.permissionMode ?? 'bypass',
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
  const defaults = defaultSettings()
  const saved = await (await open()).get<Partial<Settings>>(SETTINGS_KEY)
  return {
    ...defaults,
    ...saved,
    git: { ...defaults.git, ...saved?.git },
    lastNewSession: parseLastNewSession(saved?.lastNewSession) ?? defaults.lastNewSession,
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const current = await loadSettings()
  const next: Settings = {
    ...current,
    ...patch,
    git: patch.git ? { ...current.git, ...patch.git } : current.git,
  }
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

function parseLastNewSession(raw: unknown): LastNewSession | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<LastNewSession>
  if (!value.repoFullName || !value.baseBranch || !value.agentId) return null
  return {
    repoFullName: value.repoFullName,
    baseBranch: value.baseBranch,
    environmentId: value.environmentId ?? '',
    agentId: value.agentId,
    model: value.model ?? '',
    providerId: value.providerId ?? '',
    permissionMode: value.permissionMode ?? 'bypass',
  }
}
