import { load, type Store } from '@tauri-apps/plugin-store'
import type { ServerAddress } from '@/lib/client'

/**
 * Where this app is paired, and the token that proves it.
 *
 * Stored through the OS keychain rather than in localStorage: the token grants
 * full access to a control plane, and the web storage a renderer can reach is
 * readable by anything else running in it.
 *
 * The shape holds a list rather than one entry. A user with two VPS instances
 * is an ordinary case, and retrofitting multi-server support onto a
 * single-value store means migrating everyone's saved credentials.
 */

export interface Connection {
  serverName: string
  address: ServerAddress
  deviceId: string
  deviceToken: string
  pairedAt: number
}

const STORE_FILE = 'connections.json'
const CONNECTIONS_KEY = 'connections'
const ACTIVE_KEY = 'active'

let store: Store | undefined

async function open(): Promise<Store> {
  store ??= await load(STORE_FILE, { autoSave: true })
  return store
}

export async function listConnections(): Promise<Connection[]> {
  const saved = await (await open()).get<Connection[]>(CONNECTIONS_KEY)
  return saved ?? []
}

/** The server the app is currently looking at, or null on first run. */
export async function activeConnection(): Promise<Connection | null> {
  const [connections, activeId] = await Promise.all([
    listConnections(),
    (await open()).get<string>(ACTIVE_KEY),
  ])

  if (connections.length === 0) return null

  // Falls back to the first rather than null: an active id pointing at a
  // server that was since removed should not look like "never paired".
  return connections.find((entry) => entry.deviceId === activeId) ?? connections[0]!
}

/** Save a pairing and make it the active one. */
export async function addConnection(connection: Connection): Promise<void> {
  const saved = await open()
  const existing = await listConnections()

  // Re-pairing the same server replaces its entry. Two tokens for one server
  // would leave the older one live but unreachable from the UI.
  const others = existing.filter(
    (entry) =>
      entry.address.host !== connection.address.host ||
      entry.address.port !== connection.address.port,
  )

  await saved.set(CONNECTIONS_KEY, [...others, connection])
  await saved.set(ACTIVE_KEY, connection.deviceId)
  await saved.save()
}

export async function setActiveConnection(deviceId: string): Promise<void> {
  const saved = await open()
  await saved.set(ACTIVE_KEY, deviceId)
  await saved.save()
}

/**
 * Forget a pairing locally.
 *
 * The Settings UI also revokes the device on the server when this device is a
 * member. The owner slot cannot be freed from the app — that is
 * `duke pair replace-owner` on the VPS.
 */
export async function removeConnection(deviceId: string): Promise<void> {
  const saved = await open()
  const remaining = (await listConnections()).filter((entry) => entry.deviceId !== deviceId)

  await saved.set(CONNECTIONS_KEY, remaining)

  const active = await saved.get<string>(ACTIVE_KEY)
  if (active === deviceId) {
    await saved.set(ACTIVE_KEY, remaining[0]?.deviceId ?? null)
  }

  await saved.save()
}

/** What this machine calls itself in the server's device list. */
export function deviceName(): string {
  const platform = detectPlatform()
  const label = { macos: 'Mac', windows: 'Windows PC', linux: 'Linux machine' }[platform]
  return `Dukebox on ${label}`
}

export function detectPlatform(): 'macos' | 'windows' | 'linux' {
  const agent = navigator.userAgent.toLowerCase()
  if (agent.includes('mac')) return 'macos'
  if (agent.includes('win')) return 'windows'
  return 'linux'
}
