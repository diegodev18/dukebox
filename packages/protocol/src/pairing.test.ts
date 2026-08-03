import { describe, expect, it } from 'vitest'
import { buildPairingUrl, parsePairingUrl, type PairingPayload } from './pairing.js'

const validPayload: PairingPayload = {
  host: 'dukebox-vps',
  port: 7777,
  code: 'A1B2-C3D4',
}

describe('buildPairingUrl', () => {
  it('produces a link that parses back to the same payload', () => {
    expect(parsePairingUrl(buildPairingUrl(validPayload))).toEqual(validPayload)
  })

  it('escapes hosts that need encoding', () => {
    const url = buildPairingUrl({ ...validPayload, host: 'my host' })
    expect(url).toContain('host=my+host')
    expect(parsePairingUrl(url)?.host).toBe('my host')
  })
})

describe('parsePairingUrl', () => {
  it('tolerates surrounding whitespace from pasted text', () => {
    expect(parsePairingUrl(`  ${buildPairingUrl(validPayload)}\n`)).toEqual(validPayload)
  })

  it.each([
    ['not a url at all', 'hello world'],
    ['wrong scheme', 'https://pair?host=h&port=7777&code=A1B2-C3D4'],
    ['wrong action', 'dukebox://connect?host=h&port=7777&code=A1B2-C3D4'],
    ['missing host', 'dukebox://pair?port=7777&code=A1B2-C3D4'],
    ['missing code', 'dukebox://pair?host=h&port=7777'],
    ['empty string', ''],
  ])('rejects %s', (_label, input) => {
    expect(parsePairingUrl(input)).toBeNull()
  })

  it.each([
    ['non-numeric', 'abc'],
    ['zero', '0'],
    ['above the valid range', '70000'],
  ])('rejects a %s port', (_label, port) => {
    expect(parsePairingUrl(`dukebox://pair?host=h&port=${port}&code=A1B2-C3D4`)).toBeNull()
  })

  it.each([
    ['no separator', 'A1B2C3D4'],
    ['wrong length', 'A1B2-C3D'],
    ['lowercase', 'a1b2-c3d4'],
    ['ambiguous characters excluded from the alphabet', 'AIBO-CLD4'],
  ])('rejects a code with %s', (_label, code) => {
    expect(parsePairingUrl(`dukebox://pair?host=h&port=7777&code=${code}`)).toBeNull()
  })
})
