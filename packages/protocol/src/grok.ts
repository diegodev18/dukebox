import { z } from 'zod'

/**
 * Device-code login for a Grok subscription, as the desktop polls it.
 *
 * The control plane runs `grok login --device-auth`. The owner opens `url`
 * on any device, types `userCode`, and the server stores the resulting
 * `auth.json`. Five minutes is Grok's own sign-in ceiling.
 */

export const grokLoginStatus = z.enum([
  'idle',
  'installing',
  'waiting',
  'success',
  'failed',
  'expired',
])

export type GrokLoginStatus = z.infer<typeof grokLoginStatus>

export const grokLoginSnapshot = z.object({
  status: grokLoginStatus,
  url: z.string().optional(),
  userCode: z.string().optional(),
  expiresAt: z.number().int().optional(),
  error: z.string().optional(),
})

export type GrokLoginSnapshot = z.infer<typeof grokLoginSnapshot>

export const GROK_LOGIN_TTL_MS = 5 * 60 * 1000
