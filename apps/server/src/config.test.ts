import { serverConfig } from '@dukebox/protocol'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { applyEnvOverrides, ConfigError, fromToml, loadConfig, parseToml } from './config.js'

/** A config file shaped like the one the installer writes. */
const INSTALLER_CONFIG = `
# Written by install.sh. Do not edit while the server is running.

[server]
transport = "tailscale"
port = 7777

[database]
url = "postgres://dukebox@localhost:5432/dukebox"

[security]
master_key_file = "/etc/dukebox/master.key"

[sandbox]
default_image = "dukebox/base-node:latest"
cpu_limit = "2"
memory_limit = "4g"
`

async function writeConfig(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dukebox-config-'))
  const path = join(dir, 'config.toml')
  await writeFile(path, contents)
  return path
}

describe('parseToml', () => {
  it('reads sections and keys', () => {
    expect(parseToml('[server]\nport = 7777')).toEqual({ server: { port: 7777 } })
  })

  it('unquotes strings', () => {
    expect(parseToml('[a]\nkey = "value"')).toEqual({ a: { key: 'value' } })
  })

  it('reads booleans', () => {
    expect(parseToml('[a]\nflag = true\nother = false')).toEqual({
      a: { flag: true, other: false },
    })
  })

  it('ignores comments and blank lines', () => {
    expect(parseToml('# leading\n\n[a]\n# inline\nkey = 1\n')).toEqual({ a: { key: 1 } })
  })

  it('strips a trailing comment from a value', () => {
    expect(parseToml('[a]\nport = 7777 # the default')).toEqual({ a: { port: 7777 } })
  })

  it('tolerates whitespace around the separator', () => {
    expect(parseToml('[a]\nkey   =   "value"')).toEqual({ a: { key: 'value' } })
  })

  it('rejects a line it cannot represent rather than dropping it', () => {
    // Silently ignoring an unparseable line would lose a setting the operator
    // believed they had configured.
    expect(() => parseToml('[a]\nthis is not valid')).toThrow(ConfigError)
  })

  it('names the offending line number', () => {
    expect(() => parseToml('[a]\nkey = 1\ngarbage here')).toThrow(/line 3/)
  })
})

describe('fromToml', () => {
  it('maps the installer-written file onto the schema', () => {
    const config = serverConfig.parse(fromToml(parseToml(INSTALLER_CONFIG)))

    expect(config.server).toEqual({ transport: 'tailscale', port: 7777 })
    expect(config.database.url).toBe('postgres://dukebox@localhost:5432/dukebox')
    expect(config.security.masterKeyFile).toBe('/etc/dukebox/master.key')
    expect(config.sandbox.memoryLimit).toBe('4g')
  })

  it('translates snake_case keys to the schema camelCase', () => {
    // Operators hand-edit this file, so it uses the casing they expect.
    const config = serverConfig.parse(
      fromToml(
        parseToml(`
[database]
url = "postgres://localhost/db"
[security]
master_key_file = "/key"
[sandbox]
default_image = "custom:latest"
`),
      ),
    )

    expect(config.sandbox.defaultImage).toBe('custom:latest')
  })

  it('leaves omitted sections to the schema defaults', () => {
    const config = serverConfig.parse(
      fromToml(parseToml('[database]\nurl = "x"\n[security]\nmaster_key_file = "/k"')),
    )

    expect(config.server.port).toBe(7777)
    expect(config.sandbox.pidsLimit).toBe(512)
  })
})

describe('applyEnvOverrides', () => {
  const base = serverConfig.parse({
    database: { url: 'postgres://file/db' },
    security: { masterKeyFile: '/file/key' },
  })

  it('lets the environment override the database url', () => {
    // Needed for container deployments, where config comes from the
    // orchestrator rather than a file.
    const config = applyEnvOverrides(base, { DUKEBOX_DATABASE_URL: 'postgres://env/db' })
    expect(config.database.url).toBe('postgres://env/db')
  })

  it('keeps the file value when the variable is absent', () => {
    expect(applyEnvOverrides(base, {}).database.url).toBe('postgres://file/db')
  })

  it('overrides the port', () => {
    expect(applyEnvOverrides(base, { DUKEBOX_SERVER_PORT: '9000' }).server.port).toBe(9000)
  })

  it('ignores a port that is not a number', () => {
    expect(applyEnvOverrides(base, { DUKEBOX_SERVER_PORT: 'nine' }).server.port).toBe(7777)
  })
})

describe('loadConfig', () => {
  it('reads a file the installer would have written', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    const config = await loadConfig(path, {})

    expect(config.server.port).toBe(7777)
    expect(config.database.url).toContain('postgres://')
  })

  it('explains a missing file and what to do about it', async () => {
    await expect(loadConfig('/nonexistent/config.toml', {})).rejects.toMatchObject({
      message: expect.stringContaining('no configuration file'),
      remedy: expect.stringContaining('installer'),
    })
  })

  it('rejects a file missing required values', async () => {
    // A database url is not something to guess a default for.
    const path = await writeConfig('[server]\nport = 7777')
    await expect(loadConfig(path, {})).rejects.toThrow(ConfigError)
  })

  it('rejects an unknown transport', async () => {
    const path = await writeConfig(`
[server]
transport = "carrier-pigeon"
[database]
url = "postgres://localhost/db"
[security]
master_key_file = "/key"
`)

    await expect(loadConfig(path, {})).rejects.toThrow(ConfigError)
  })

  it('applies environment overrides on top of the file', async () => {
    const path = await writeConfig(INSTALLER_CONFIG)
    const config = await loadConfig(path, { DUKEBOX_SERVER_PORT: '8080' })

    expect(config.server.port).toBe(8080)
  })

  it('carries no secrets of its own', async () => {
    // Every deployment-specific value comes from the operator's machine at
    // runtime; the published binaries are identical for everyone.
    const path = await writeConfig(INSTALLER_CONFIG)
    const config = await loadConfig(path, {})

    // The master key lives in a file the installer generated, referenced by
    // path — it is never a literal in config or code.
    expect(config.security.masterKeyFile).toMatch(/^\//)
  })
})
