import { describe, expect, it } from 'vitest'
import {
  defaultProjectConfig,
  mergeProjectConfig,
  parseSecretReference,
  projectConfig,
  serverConfig,
} from './config.js'

describe('projectConfig', () => {
  it('fills in every field for a repo with no .duke/config.yaml', () => {
    const config = defaultProjectConfig()
    expect(config.setup).toEqual([])
    expect(config.env).toEqual({})
    expect(config.agents).toEqual([])
    expect(config.image).toBe('dukebox/base-node:latest')
  })

  it('keeps values the repo does specify', () => {
    const config = projectConfig.parse({
      image: 'node:22',
      setup: ['pnpm install'],
      ports: [3000],
    })
    expect(config.image).toBe('node:22')
    expect(config.setup).toEqual(['pnpm install'])
    expect(config.ports).toEqual([3000])
    // Unspecified fields still get defaults.
    expect(config.dev).toEqual([])
  })

  it('rejects ports outside the valid range', () => {
    expect(projectConfig.safeParse({ ports: [0] }).success).toBe(false)
    expect(projectConfig.safeParse({ ports: [70000] }).success).toBe(false)
  })
})

describe('mergeProjectConfig', () => {
  it('merges env key by key so an override need not restate the map', () => {
    const base = projectConfig.parse({ env: { A: '1', B: '2' } })
    const merged = mergeProjectConfig(base, { env: { B: 'override', C: '3' } })
    expect(merged.env).toEqual({ A: '1', B: 'override', C: '3' })
  })

  it('replaces arrays wholesale rather than concatenating', () => {
    const base = projectConfig.parse({ setup: ['pnpm install'] })
    const merged = mergeProjectConfig(base, { setup: ['npm ci'] })
    expect(merged.setup).toEqual(['npm ci'])
  })

  it('leaves the base untouched when the override is empty', () => {
    const base = projectConfig.parse({ image: 'node:22', env: { A: '1' } })
    expect(mergeProjectConfig(base, {})).toEqual(base)
  })
})

describe('parseSecretReference', () => {
  it('extracts the secret name', () => {
    expect(parseSecretReference('${secret.DATABASE_URL}')).toBe('DATABASE_URL')
  })

  it.each([
    ['a plain literal', 'postgres://localhost'],
    ['lowercase names', '${secret.database_url}'],
    ['text around the reference', 'prefix${secret.FOO}'],
    ['an empty name', '${secret.}'],
  ])('returns null for %s', (_label, input) => {
    expect(parseSecretReference(input)).toBeNull()
  })
})

describe('serverConfig', () => {
  const minimal = {
    database: { url: 'postgres://dukebox@localhost/dukebox' },
    security: { masterKeyFile: '/etc/dukebox/master.key' },
  }

  it('defaults everything the installer does not have to write', () => {
    const config = serverConfig.parse(minimal)
    expect(config.server.transport).toBe('tailscale')
    expect(config.server.port).toBe(7777)
    expect(config.sandbox.pidsLimit).toBe(512)
  })

  it('requires a database url and a master key path', () => {
    expect(serverConfig.safeParse({ security: minimal.security }).success).toBe(false)
    expect(serverConfig.safeParse({ database: minimal.database }).success).toBe(false)
  })

  it('rejects an unknown transport', () => {
    const result = serverConfig.safeParse({ ...minimal, server: { transport: 'carrier-pigeon' } })
    expect(result.success).toBe(false)
  })
})
