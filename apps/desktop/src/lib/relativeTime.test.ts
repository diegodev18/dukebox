import { describe, expect, it } from 'vitest'
import { relativeAge } from '@/lib/relativeTime'

describe('relativeAge', () => {
  const now = 1_700_000_000_000

  it('says now for anything under a minute', () => {
    expect(relativeAge(now, now)).toBe('now')
    expect(relativeAge(now - 59_000, now)).toBe('now')
  })

  it('counts minutes, hours, then days', () => {
    expect(relativeAge(now - 60_000, now)).toBe('1m')
    expect(relativeAge(now - 3_600_000, now)).toBe('1h')
    expect(relativeAge(now - 86_400_000, now)).toBe('1d')
  })

  it('does not go negative for timestamps in the future', () => {
    expect(relativeAge(now + 10_000, now)).toBe('now')
  })
})
