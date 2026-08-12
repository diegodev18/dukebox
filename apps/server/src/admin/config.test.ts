import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ConfigError, loadConfig } from '../config.js'
import {
  configFields,
  effectiveValues,
  formatConfigValue,
  readConfigValue,
  redactDatabaseUrl,
  setConfigValue,
  setTomlKey,
} from './config.js'

const INSTALLER_CONFIG = `# Written by install.sh. Safe to edit; restart with:
#   systemctl restart dukebox

[server]
transport = "tailscale"
port = 7777

[database]
url = "postgres://dukebox:secret@127.0.0.1:5432/dukebox"

[redis]
url = "redis://127.0.0.1:6379"

[security]
master_key_file = "/etc/dukebox/master.key"

[sandbox]
default_image = "dukebox/base-node:latest"
cpu_limit = "2"
memory_limit = "4g"
`

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dukebox-admin-config-'))
  const path = join(dir, 'config.toml')
  await writeFile(path, contents)
  return path
}

describe('configFields', () => {
  it('discovers every key with the right TOML name and type', () => {
    const fields = configFields()
    expect(fields.find((f) => f.section === 'server' && f.key === 'port')?.type).toBe('number')
    expect(fields.find((f) => f.section === 'sandbox' && f.key === 'cpu_limit')?.type).toBe(
      'string',
    )
    expect(fields.find((f) => f.section === 'sandbox' && f.key === 'pids_limit')?.type).toBe(
      'number',
    )
    expect(fields.find((f) => f.section === 'database' && f.key === 'url')?.protected).toBe(true)
    expect(
      fields.find((f) => f.section === 'security' && f.key === 'master_key_file')?.protected,
    ).toBe(true)
  })
})

describe('setTomlKey', () => {
  it('rewrites an existing value, keeping everything else byte for byte', () => {
    const updated = setTomlKey(INSTALLER_CONFIG, 'server', 'port', '8888')
    expect(updated).toContain('port = 8888')
    expect(updated).not.toContain('port = 7777')
    expect(updated).toContain('# Written by install.sh. Safe to edit; restart with:')
    expect(updated).toContain('url = "redis://127.0.0.1:6379"')
  })

  it('adds a missing key to an existing section', () => {
    const updated = setTomlKey(INSTALLER_CONFIG, 'sandbox', 'idle_ttl_seconds', '7200')
    expect(updated).toContain('idle_ttl_seconds = 7200')
  })

  it('creates a section that does not exist yet', () => {
    const updated = setTomlKey('[server]\nport = 7777\n', 'sandbox', 'cpu_limit', '"4"')
    expect(updated).toContain('[sandbox]')
    expect(updated).toContain('cpu_limit = "4"')
  })

  it('only changes the matching section', () => {
    const source = '[a]\nvalue = 1\n\n[b]\nvalue = 2\n'
    const updated = setTomlKey(source, 'b', 'value', '3')
    expect(updated).toBe('[a]\nvalue = 1\n\n[b]\nvalue = 3\n')
  })
})

describe('readConfigValue', () => {
  it('reads a raw value from the file', () => {
    const { found, value } = readConfigValue(INSTALLER_CONFIG, 'server', 'port')
    expect(found).toBe(true)
    expect(value).toBe(7777)
  })

  it('reports an unset key', () => {
    expect(readConfigValue(INSTALLER_CONFIG, 'sandbox', 'missing').found).toBe(false)
  })
})

describe('setConfigValue', () => {
  it('writes a validated change to the file', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    await setConfigValue(path, 'server', 'port', '8888')
    const written = await readFile(path, 'utf8')
    expect(written).toContain('port = 8888')
  })

  it('rejects an invalid value without touching the file', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    await expect(setConfigValue(path, 'server', 'port', 'not-a-number')).rejects.toThrow(
      ConfigError,
    )
    expect(await readFile(path, 'utf8')).toContain('port = 7777')
  })

  it('rejects an unknown key', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    await expect(setConfigValue(path, 'server', 'nope', '1')).rejects.toThrow(/unknown key/)
  })

  it('refuses protected keys without --force', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    await expect(
      setConfigValue(path, 'database', 'url', 'postgres://x:y@127.0.0.1:5432/z'),
    ).rejects.toThrow(/not editable without --force/)
  })

  it('allows a protected key with --force', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    await setConfigValue(path, 'security', 'master_key_file', '/etc/dukebox/master2.key', true)
    expect(await readFile(path, 'utf8')).toContain('master_key_file = "/etc/dukebox/master2.key"')
  })
})

describe('redactDatabaseUrl', () => {
  it('hides the password in a postgres URL', () => {
    expect(redactDatabaseUrl('postgres://dukebox:secret@127.0.0.1:5432/dukebox')).toContain(
      'dukebox:***@',
    )
    expect(redactDatabaseUrl('postgres://dukebox:secret@127.0.0.1:5432/dukebox')).not.toContain(
      ':secret@',
    )
  })
})

describe('effectiveValues / formatConfigValue', () => {
  it('maps effective config onto TOML keys', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    const config = await loadConfig(path)
    const values = effectiveValues(config)
    const port = values.find((v) => v.key === 'server.port')
    expect(port?.value).toBe(7777)
    expect(formatConfigValue('2')).toBe('2')
    expect(formatConfigValue(undefined)).toBe('(unset)')
  })
})
