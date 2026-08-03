import { serverConfig, type ServerConfig } from '@dukebox/protocol'
import { readFile } from 'node:fs/promises'

/**
 * Runtime configuration.
 *
 * Dukebox is open source, so the binaries are identical for everyone: nothing
 * deployment-specific may be baked into a build. Everything here is read at
 * startup from a file the installer generated on the operator's own machine,
 * with environment variables able to override any of it for container
 * deployments.
 */

export const DEFAULT_CONFIG_PATH = '/etc/dukebox/config.toml'

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly remedy?: string,
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

/**
 * Minimal TOML reader.
 *
 * The config file is a fixed, small shape written by our own installer, so a
 * TOML dependency would be more surface than the format needs. Anything beyond
 * `[section]` headers and `key = value` lines is rejected rather than guessed
 * at, so a file this cannot represent fails loudly instead of silently losing
 * settings.
 */
export function parseToml(source: string): Record<string, Record<string, unknown>> {
  const result: Record<string, Record<string, unknown>> = {}
  let section = ''

  source.split('\n').forEach((rawLine, index) => {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (line === '') return

    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line)
    if (sectionMatch?.[1]) {
      section = sectionMatch[1]
      result[section] ??= {}
      return
    }

    const pairMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    if (!pairMatch) {
      throw new ConfigError(`cannot parse line ${index + 1}: ${rawLine.trim()}`)
    }

    const [, key, rawValue] = pairMatch
    if (!key || rawValue === undefined) return

    const target = (result[section] ??= {})
    target[key] = parseValue(rawValue.trim())
  })

  return result
}

function parseValue(raw: string): unknown {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false

  const asNumber = Number(raw)
  return Number.isFinite(asNumber) && raw !== '' ? asNumber : raw
}

/**
 * Map a TOML document onto the config schema.
 *
 * TOML keys are snake_case, matching what an operator would expect to hand
 * edit; the schema is camelCase, matching the rest of the codebase.
 */
export function fromToml(document: Record<string, Record<string, unknown>>): unknown {
  const section = (name: string) => document[name] ?? {}

  return {
    server: {
      ...(section('server').transport !== undefined
        ? { transport: section('server').transport }
        : {}),
      ...(section('server').port !== undefined ? { port: section('server').port } : {}),
    },
    database: { url: section('database').url },
    ...(section('redis').url !== undefined ? { redis: { url: section('redis').url } } : {}),
    security: { masterKeyFile: section('security').master_key_file },
    sandbox: {
      ...(section('sandbox').default_image !== undefined
        ? { defaultImage: section('sandbox').default_image }
        : {}),
      ...(section('sandbox').cpu_limit !== undefined
        ? { cpuLimit: section('sandbox').cpu_limit }
        : {}),
      ...(section('sandbox').memory_limit !== undefined
        ? { memoryLimit: section('sandbox').memory_limit }
        : {}),
    },
  }
}

/**
 * Apply environment overrides.
 *
 * Needed for container deployments, where config comes from the orchestrator
 * rather than a file on disk.
 */
export function applyEnvOverrides(config: ServerConfig, env: NodeJS.ProcessEnv): ServerConfig {
  const port = env.DUKEBOX_SERVER_PORT ? Number(env.DUKEBOX_SERVER_PORT) : undefined

  return {
    ...config,
    server: {
      ...config.server,
      ...(port !== undefined && Number.isFinite(port) ? { port } : {}),
    },
    database: { url: env.DUKEBOX_DATABASE_URL ?? config.database.url },
    redis: { url: env.DUKEBOX_REDIS_URL ?? config.redis.url },
    security: {
      masterKeyFile: env.DUKEBOX_MASTER_KEY_FILE ?? config.security.masterKeyFile,
    },
  }
}

/** Read and validate the config, failing with something the operator can act on. */
export async function loadConfig(
  path = DEFAULT_CONFIG_PATH,
  env: NodeJS.ProcessEnv = process.env,
): Promise<ServerConfig> {
  let source: string

  try {
    source = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new ConfigError(
        `no configuration file at ${path}`,
        'Run the installer, or point DUKEBOX_CONFIG at an existing file.',
      )
    }
    throw error
  }

  const parsed = serverConfig.safeParse(fromToml(parseToml(source)))
  if (!parsed.success) {
    throw new ConfigError(`${path} is not valid: ${parsed.error.message}`)
  }

  return applyEnvOverrides(parsed.data, env)
}
