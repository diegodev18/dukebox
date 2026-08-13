import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(),
}))

import { load } from '@tauri-apps/plugin-store'

/**
 * The store plugin talks to the native side; here it is a plain map.
 * `loadSettings` caches the store behind a module-level variable, so every
 * test reloads the module to start with a clean cache — otherwise the second
 * test would keep reading the store the first one cached.
 */

function store(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  return {
    get: vi.fn(async (key: string) => data.get(key)),
    set: vi.fn(async (key: string, value: unknown) => {
      data.set(key, value)
    }),
    save: vi.fn(async () => undefined),
  }
}

async function settingsModule() {
  vi.resetModules()
  return await import('@/lib/settings')
}

afterEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

describe('loadSettings', () => {
  it('returns defaults when nothing is saved yet', async () => {
    const { defaultSettings, loadSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await expect(loadSettings()).resolves.toEqual(defaultSettings())
  })

  it('merges saved values over the defaults', async () => {
    const { loadSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store({ settings: { theme: 'dark' } }) as never)

    await expect(loadSettings()).resolves.toEqual({
      theme: 'dark',
      checkForUpdatesOnLaunch: true,
      commitIdentity: null,
      lastNewSession: null,
      git: {
        createAsDraft: true,
        autoOpenDraft: true,
        commitOnTurnEnd: true,
        mergeMethod: 'squash',
        deleteBranchAfterMerge: true,
        prDescription: 'auto',
      },
    })
  })

  it('restores the last New Session pickers', async () => {
    const lastNewSession = {
      repoFullName: 'acme/app',
      baseBranch: 'main',
      environmentId: '',
      agentId: 'claude-code',
      model: 'opus',
      providerId: '',
      permissionMode: 'plan',
    }
    const { loadSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store({ settings: { lastNewSession } }) as never)

    await expect(loadSettings()).resolves.toMatchObject({ lastNewSession })
  })
})

describe('saveSettings', () => {
  it('persists a partial change and reports the merged settings', async () => {
    const { saveSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    const next = await saveSettings({ theme: 'dark' })

    expect(next).toMatchObject({ theme: 'dark' })
    // The launch check survives a change that did not touch it.
    expect(next.checkForUpdatesOnLaunch).toBe(true)
  })

  it('persists the commit identity', async () => {
    const { saveSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    const identity = { name: 'Diego', email: 'diego@example.com' }
    await expect(saveSettings({ commitIdentity: identity })).resolves.toMatchObject({
      commitIdentity: identity,
    })
  })

  it('persists the last New Session pickers', async () => {
    const { saveSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    const lastNewSession = {
      repoFullName: 'acme/app',
      baseBranch: 'main',
      environmentId: '',
      agentId: 'claude-code',
      model: 'opus',
      providerId: '',
      permissionMode: 'plan',
    }
    await expect(saveSettings({ lastNewSession })).resolves.toMatchObject({ lastNewSession })
  })

  it('mirrors a theme change into localStorage for the next boot', async () => {
    const { saveSettings } = await settingsModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await saveSettings({ theme: 'dark' })

    expect(localStorage.getItem('dukebox.theme')).toBe('dark')
  })
})

describe('applyTheme', () => {
  it('pins an explicit theme on the root', async () => {
    const { applyTheme } = await settingsModule()
    applyTheme('dark')
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark')
  })

  it('removes the attribute for the system theme', async () => {
    const { applyTheme } = await settingsModule()
    applyTheme('dark')
    applyTheme('system')
    expect(document.documentElement.hasAttribute('data-theme')).toBe(false)
  })
})

describe('bootTheme', () => {
  it('follows the OS when no theme was saved', async () => {
    const { bootTheme } = await settingsModule()
    expect(bootTheme()).toBe('system')
  })

  it('reads the saved theme back from the mirror', async () => {
    const { bootTheme } = await settingsModule()
    localStorage.setItem('dukebox.theme', 'light')
    expect(bootTheme()).toBe('light')
  })
})

describe('lastNewSessionFromSummary', () => {
  it('copies repo, branch, agent, environment, and permission from the session', async () => {
    const { lastNewSessionFromSummary } = await settingsModule()
    const project = {
      id: '00000000-0000-4000-8000-000000000001',
      repoFullName: 'acme/app',
      defaultBranch: 'main',
      environmentCount: 1,
      createdAt: 1,
      sessionCount: 1,
    }

    expect(
      lastNewSessionFromSummary(
        {
          id: '00000000-0000-4000-8000-000000000010',
          projectId: project.id,
          agentId: 'claude-code',
          status: 'done',
          purpose: 'coding',
          title: 'do a thing',
          branch: 'duke/abc',
          baseBranch: 'main',
          changedFileCount: 0,
          createdAt: 1,
          updatedAt: 1,
          lastSeq: 0,
          pullRequestUrl: null,
          pullRequest: null,
          environmentId: '00000000-0000-4000-8000-0000000000e1',
          permissionMode: 'plan',
        },
        [project],
      ),
    ).toEqual({
      repoFullName: 'acme/app',
      baseBranch: 'main',
      environmentId: '00000000-0000-4000-8000-0000000000e1',
      agentId: 'claude-code',
      model: '',
      providerId: '',
      permissionMode: 'plan',
    })
  })

  it('returns null when there is no session or the project is gone', async () => {
    const { lastNewSessionFromSummary } = await settingsModule()
    expect(lastNewSessionFromSummary(undefined, [])).toBeNull()
    expect(
      lastNewSessionFromSummary(
        {
          id: '00000000-0000-4000-8000-000000000010',
          projectId: '00000000-0000-4000-8000-000000000099',
          agentId: 'claude-code',
          status: 'done',
          purpose: 'coding',
          title: 'do a thing',
          branch: 'duke/abc',
          baseBranch: 'main',
          changedFileCount: 0,
          createdAt: 1,
          updatedAt: 1,
          lastSeq: 0,
          pullRequestUrl: null,
          pullRequest: null,
          environmentId: null,
          permissionMode: null,
        },
        [],
      ),
    ).toBeNull()
  })
})
