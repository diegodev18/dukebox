import { describe, expect, it } from 'vitest'
import { resetRateLimit, tooManyAttempts } from '@/http/rateLimit'

describe('tooManyAttempts', () => {
  it('allows a burst and then refuses', () => {
    resetRateLimit()
    for (let i = 0; i < 30; i++) {
      expect(tooManyAttempts('test')).toBe(false)
    }
    expect(tooManyAttempts('test')).toBe(true)
  })

  it('tracks keys independently', () => {
    resetRateLimit()
    for (let i = 0; i < 30; i++) tooManyAttempts('a')
    expect(tooManyAttempts('a')).toBe(true)
    expect(tooManyAttempts('b')).toBe(false)
  })
})
