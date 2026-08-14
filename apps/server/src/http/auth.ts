import type { Device } from '@dukebox/db'
import type { Context, Next } from 'hono'
import { deviceIsOwner } from '@/auth/pairing'

/**
 * Auth helpers shared by the HTTP routes.
 *
 * The pairing middleware puts the calling device on the context. Owner-only
 * routes refuse members with the same 403 the desktop maps to a sentence,
 * rather than a generic error that looks like a bug.
 */

export type AuthedVariables = { device: Device }

export const OWNER_FORBIDDEN = {
  error: 'forbidden',
  message: 'only the owner of this server can do that',
} as const

export async function requireOwner(
  c: Context<{ Variables: AuthedVariables }>,
  next: Next,
): Promise<Response | void> {
  if (!deviceIsOwner(c.get('device'))) {
    return c.json(OWNER_FORBIDDEN, 403)
  }
  await next()
}

/**
 * Route params are `string | undefined` under `noUncheckedIndexedAccess`.
 * Missing params cannot match a uuid row, so callers treat `''` as not found.
 */
export function routeParam(c: Context, name: string): string {
  return c.req.param(name) ?? ''
}
