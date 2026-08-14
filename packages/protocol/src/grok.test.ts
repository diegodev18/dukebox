import { describe, expect, it } from 'vitest'
import { GROK_LOGIN_TTL_MS, grokLoginSnapshot } from '@/grok'

describe('grokLoginSnapshot', () => {
  it('accepts a waiting device-code payload', () => {
    const parsed = grokLoginSnapshot.parse({
      status: 'waiting',
      url: 'https://accounts.x.ai/activate',
      userCode: 'ABCD-EFGH',
      expiresAt: Date.now() + GROK_LOGIN_TTL_MS,
    })
    expect(parsed.userCode).toBe('ABCD-EFGH')
  })

  it('allows idle without extras', () => {
    expect(grokLoginSnapshot.parse({ status: 'idle' })).toEqual({ status: 'idle' })
  })
})
