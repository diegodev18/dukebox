/**
 * Grok Build `auth.json` helpers.
 *
 * The file is an issuer-keyed map written by `grok login`. Access tokens last
 * a few hours; refresh tokens rotate. Dukebox has to merge snapshots from the
 * secret store and from the container without dropping the refresh token, or
 * the next session is handed a revoked grant and `grok -p` prints
 * "Not signed in".
 */

export const GROK_REAUTH_MESSAGE =
  'Grok is not signed in. Open Settings and sign in again with the device code. The saved session expired and could not be renewed.'

const UNSIGNED = /not signed in/i

export function isGrokUnsignedError(message: string): boolean {
  return UNSIGNED.test(message)
}

export interface GrokAuthEntry {
  key?: string
  refresh_token?: string
  expires_at?: string
  create_time?: string
  oidc_client_id?: string
  oidc_issuer?: string
  auth_mode?: string
  [key: string]: unknown
}

export type GrokAuthFile = Record<string, GrokAuthEntry>

export function parseGrokAuthJson(raw: string): GrokAuthFile | null {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as GrokAuthFile
  } catch {
    return null
  }
}

function sessionEntry(file: GrokAuthFile): GrokAuthEntry | undefined {
  for (const value of Object.values(file)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value
  }
  return undefined
}

export function grokAuthExpiresAt(file: GrokAuthFile): Date | null {
  const entry = sessionEntry(file)
  if (!entry?.expires_at) return null
  const date = new Date(entry.expires_at)
  return Number.isNaN(date.getTime()) ? null : date
}

export function grokAuthNeedsRefresh(
  raw: string,
  now: Date = new Date(),
  earlyMs = 5 * 60 * 1000,
): boolean {
  const file = parseGrokAuthJson(raw)
  if (!file) return false
  const expires = grokAuthExpiresAt(file)
  if (!expires) return false
  return expires.getTime() - now.getTime() <= earlyMs
}

export function grokAuthClientId(raw: string): string | null {
  const entry = sessionEntry(parseGrokAuthJson(raw) ?? {})
  return typeof entry?.oidc_client_id === 'string' && entry.oidc_client_id
    ? entry.oidc_client_id
    : null
}

export function grokAuthRefreshToken(raw: string): string | null {
  const entry = sessionEntry(parseGrokAuthJson(raw) ?? {})
  return typeof entry?.refresh_token === 'string' && entry.refresh_token
    ? entry.refresh_token
    : null
}

export function preferFresherGrokAuth(a: string | null, b: string | null): string | null {
  if (!a) return b
  if (!b) return a
  const aExp = grokAuthExpiresAt(parseGrokAuthJson(a) ?? {})
  const bExp = grokAuthExpiresAt(parseGrokAuthJson(b) ?? {})
  if (aExp && bExp) return aExp.getTime() >= bExp.getTime() ? a : b
  if (bExp && !aExp) return b
  return a
}

/**
 * Combine the secret-store snapshot with whatever Grok wrote in the container.
 *
 * The later `expires_at` wins for the access token. A refresh token present
 * on either side is kept: the container snapshot often has none (or an older
 * one) after a host-side refresh.
 */
export function mergeGrokAuthJson(store: string | null, disk: string | null): string | null {
  if (!store) return disk
  if (!disk) return store

  const chosen = preferFresherGrokAuth(store, disk)
  if (!chosen) return null

  const storeFile = store ? parseGrokAuthJson(store) : null
  const diskFile = disk ? parseGrokAuthJson(disk) : null
  const chosenFile = parseGrokAuthJson(chosen)
  if (!chosenFile) return chosen

  const keys = new Set([
    ...Object.keys(storeFile ?? {}),
    ...Object.keys(diskFile ?? {}),
    ...Object.keys(chosenFile),
  ])

  const merged: GrokAuthFile = { ...chosenFile }
  for (const key of keys) {
    const storeEntry = storeFile?.[key]
    const diskEntry = diskFile?.[key]
    const base = chosenFile[key] ?? diskEntry ?? storeEntry
    if (!base) continue

    const refresh = pickRefresh(diskEntry, storeEntry) ?? pickRefresh(base)
    merged[key] =
      refresh && base.refresh_token !== refresh ? { ...base, refresh_token: refresh } : base
  }

  return JSON.stringify(merged)
}

function pickRefresh(...entries: Array<GrokAuthEntry | undefined>): string | undefined {
  for (const entry of entries) {
    if (typeof entry?.refresh_token === 'string' && entry.refresh_token) return entry.refresh_token
  }
  return undefined
}

export function applyRefreshedTokens(
  raw: string,
  tokens: { access_token: string; refresh_token?: string; expires_in: number },
  now: Date = new Date(),
): string {
  const file = parseGrokAuthJson(raw)
  if (!file) return raw

  const expiresAt = new Date(now.getTime() + tokens.expires_in * 1000).toISOString()
  const createTime = now.toISOString()

  const next: GrokAuthFile = {}
  for (const [key, entry] of Object.entries(file)) {
    if (!entry || typeof entry !== 'object') {
      next[key] = entry
      continue
    }
    const refresh = tokens.refresh_token || entry.refresh_token
    next[key] = {
      ...entry,
      key: tokens.access_token,
      ...(refresh ? { refresh_token: refresh } : {}),
      expires_at: expiresAt,
      create_time: createTime,
    }
  }
  return JSON.stringify(next)
}
