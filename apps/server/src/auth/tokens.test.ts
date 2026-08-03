import { pairingCode, PAIRING_CODE_PATTERN } from '@dukebox/protocol'
import { describe, expect, it } from 'vitest'
import {
  generateDeviceToken,
  generatePairingCode,
  hashSecret,
  normalizePairingCode,
  secretsMatch,
} from './tokens.js'

describe('generatePairingCode', () => {
  it('produces the format the pairing link expects', () => {
    expect(generatePairingCode()).toMatch(PAIRING_CODE_PATTERN)
  })

  it('avoids characters that are easy to misread when retyped', () => {
    // I, L, O and U are excluded: a user reads these off a terminal and types
    // them into an app.
    const codes = Array.from({ length: 200 }, generatePairingCode).join('')
    expect(codes).not.toMatch(/[ILOU]/)
  })

  it('does not repeat', () => {
    const codes = new Set(Array.from({ length: 500 }, generatePairingCode))
    expect(codes.size).toBe(500)
  })
})

describe('generateDeviceToken', () => {
  it('is URL-safe, since it travels in headers and config files', () => {
    expect(generateDeviceToken()).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('carries enough entropy to be unguessable', () => {
    // 32 random bytes. These are long-lived and grant full access, so they are
    // sized against brute force rather than for human handling.
    expect(generateDeviceToken().length).toBeGreaterThanOrEqual(43)
  })

  it('does not repeat', () => {
    const tokens = new Set(Array.from({ length: 500 }, generateDeviceToken))
    expect(tokens.size).toBe(500)
  })
})

describe('hashSecret', () => {
  it('is deterministic', () => {
    expect(hashSecret('secret')).toBe(hashSecret('secret'))
  })

  it('differs for different inputs', () => {
    expect(hashSecret('a')).not.toBe(hashSecret('b'))
  })

  it('does not contain the input', () => {
    // What is stored must not be reversible into the token itself.
    const secret = 'a-recognizable-secret'
    expect(hashSecret(secret)).not.toContain(secret)
  })

  it('produces a fixed-length hex digest', () => {
    expect(hashSecret('short')).toMatch(/^[0-9a-f]{64}$/)
    expect(hashSecret('x'.repeat(10_000))).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('secretsMatch', () => {
  it('accepts identical values', () => {
    expect(secretsMatch('abc', 'abc')).toBe(true)
  })

  it('rejects different values', () => {
    expect(secretsMatch('abc', 'abd')).toBe(false)
  })

  it('rejects values of different lengths without throwing', () => {
    // timingSafeEqual throws on a length mismatch, which would itself leak.
    expect(secretsMatch('abc', 'abcdef')).toBe(false)
  })

  it('handles empty strings', () => {
    expect(secretsMatch('', '')).toBe(true)
    expect(secretsMatch('', 'a')).toBe(false)
  })
})

describe('normalizePairingCode', () => {
  it('accepts the code exactly as printed', () => {
    expect(normalizePairingCode('A1B2-C3D4')).toBe('A1B2-C3D4')
  })

  it.each([
    ['lowercase', 'a1b2-c3d4'],
    ['no separator', 'A1B2C3D4'],
    ['surrounding whitespace', '  A1B2-C3D4  '],
    ['internal spaces', 'A1B2 C3D4'],
  ])('normalizes %s', (_label, input) => {
    // Users retype these from a terminal; these are expected inputs, not errors.
    expect(normalizePairingCode(input)).toBe('A1B2-C3D4')
  })

  it('leaves a value of the wrong length alone for the validator to reject', () => {
    expect(normalizePairingCode('short')).toBe('SHORT')
  })

  it('formats without validating, so bad characters still reach the validator', () => {
    // Eight characters, so it gets the separator — but N and S are not in the
    // alphabet. Rejecting that is the schema's job, not this function's.
    const normalized = normalizePairingCode('nonsense')

    expect(normalized).toBe('NONS-ENSE')
    expect(pairingCode.safeParse(normalized).success).toBe(false)
  })

  it('produces something the validator accepts for a real code', () => {
    const normalized = normalizePairingCode(generatePairingCode().toLowerCase().replace('-', ''))
    expect(pairingCode.safeParse(normalized).success).toBe(true)
  })
})
