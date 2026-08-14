import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn(),
}))

import { load } from '@tauri-apps/plugin-store'
import type { Connection } from '@/lib/connection'

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

async function connectionModule() {
  vi.resetModules()
  return await import('@/lib/connection')
}

const debian: Connection = {
  serverName: 'debian-01',
  address: { host: 'debian-01.tailnet.ts.net', port: 7777, tls: false },
  deviceId: 'device-1',
  deviceToken: 'token-1',
  pairedAt: 1,
}

const other: Connection = {
  serverName: 'debian-02',
  address: { host: 'debian-02.tailnet.ts.net', port: 7777, tls: false },
  deviceId: 'device-2',
  deviceToken: 'token-2',
  pairedAt: 2,
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('listConnections', () => {
  it('returns nothing when the store is empty', async () => {
    const { listConnections } = await connectionModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await expect(listConnections()).resolves.toEqual([])
  })
})

describe('addConnection', () => {
  it('saves the pairing and makes it active', async () => {
    const { addConnection, listConnections, activeConnection } = await connectionModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await addConnection(debian)

    await expect(listConnections()).resolves.toEqual([debian])
    await expect(activeConnection()).resolves.toEqual(debian)
  })

  it('replaces a pairing for the same host and port', async () => {
    const { addConnection, listConnections } = await connectionModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await addConnection(debian)
    await addConnection({ ...debian, deviceId: 'device-1b', deviceToken: 'token-1b' })

    const listed = await listConnections()
    expect(listed).toHaveLength(1)
    expect(listed[0]).toMatchObject({ deviceId: 'device-1b', deviceToken: 'token-1b' })
  })
})

describe('activeConnection', () => {
  it('falls back to the first pairing when the active id is gone', async () => {
    const { activeConnection } = await connectionModule()
    vi.mocked(load).mockResolvedValue(
      store({
        connections: [debian, other],
        active: 'removed-device',
      }) as never,
    )

    await expect(activeConnection()).resolves.toEqual(debian)
  })

  it('returns null when nothing is paired', async () => {
    const { activeConnection } = await connectionModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await expect(activeConnection()).resolves.toBeNull()
  })
})

describe('removeConnection', () => {
  it('promotes the remaining pairing when the active one is forgotten', async () => {
    const { addConnection, removeConnection, activeConnection, listConnections } =
      await connectionModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await addConnection(debian)
    await addConnection(other)
    await removeConnection(other.deviceId)

    await expect(listConnections()).resolves.toEqual([debian])
    await expect(activeConnection()).resolves.toEqual(debian)
  })

  it('clears the active id when the last pairing is forgotten', async () => {
    const { addConnection, removeConnection, activeConnection } = await connectionModule()
    vi.mocked(load).mockResolvedValue(store() as never)

    await addConnection(debian)
    await removeConnection(debian.deviceId)

    await expect(activeConnection()).resolves.toBeNull()
  })
})

describe('detectPlatform', () => {
  it.each([
    ['Macintosh', 'macos', 'Dukebox on Mac'],
    ['Windows NT 10.0', 'windows', 'Dukebox on Windows PC'],
    ['X11; Linux x86_64', 'linux', 'Dukebox on Linux machine'],
  ] as const)('reads %s', async (agent, platform, name) => {
    const { detectPlatform, deviceName } = await connectionModule()
    vi.stubGlobal('navigator', { userAgent: agent })

    expect(detectPlatform()).toBe(platform)
    expect(deviceName()).toBe(name)

    vi.unstubAllGlobals()
  })
})
