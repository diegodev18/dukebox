import { readFile, writeFile } from 'node:fs/promises'
import { serverConfig, type ServerConfig } from '@dukebox/protocol'
import { z } from 'zod'
import { ConfigError, fromToml, parseToml } from '../config.js'

/**
 * Read and edit `/etc/dukebox/config.toml` from the CLI.
 *
 * `config set` rewrites a single line so comments and the rest of the file
 * survive untouched, validates the result against the shared schema, and
 * refuses to change keys that would break pairing or decrypting secrets
 * (`database.url`, `security.master_key_file`) unless `--force` is passed.
 */

export type FieldType = 'string' | 'number' | 'boolean'

export interface ConfigField {
  section: string
  /** TOML key, as it appears in the file (snake_case). */
  key: string
  /** Schema key (camelCase), for reading the effective config. */
  schemaKey: string
  type: FieldType
  protected: boolean
}

const PROTECTED_KEYS = new Set(['database.url', 'security.master_key_file'])

function camelToSnake(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)
}

function unwrap(field: z.ZodTypeAny): z.ZodTypeAny {
  return field instanceof z.ZodDefault ? field._def.innerType : field
}

function fieldType(field: z.ZodTypeAny): FieldType {
  const inner = unwrap(field)
  if (inner instanceof z.ZodNumber) return 'number'
  if (inner instanceof z.ZodBoolean) return 'boolean'
  if (inner instanceof z.ZodString || inner instanceof z.ZodEnum) return 'string'
  return 'string'
}

/** Every editable key in the config file, discovered from the shared schema. */
export function configFields(): ConfigField[] {
  const fields: ConfigField[] = []

  for (const [section, sectionField] of Object.entries(serverConfig.shape)) {
    const object = unwrap(sectionField) as z.ZodObject<Record<string, z.ZodTypeAny>>
    for (const [schemaKey, field] of Object.entries(object.shape)) {
      const key = camelToSnake(schemaKey)
      fields.push({
        section,
        key,
        schemaKey,
        type: fieldType(field),
        protected: PROTECTED_KEYS.has(`${section}.${key}`),
      })
    }
  }

  return fields
}

export function fieldFor(section: string, key: string): ConfigField | undefined {
  return configFields().find((field) => field.section === section && field.key === key)
}

function formatTomlValue(type: FieldType, raw: string): string {
  switch (type) {
    case 'number': {
      const parsed = Number(raw)
      if (!Number.isFinite(parsed)) throw new ConfigError(`expected a number, got "${raw}"`)
      return String(parsed)
    }
    case 'boolean':
      if (raw !== 'true' && raw !== 'false') {
        throw new ConfigError(`expected true or false, got "${raw}"`)
      }
      return raw
    case 'string':
      return JSON.stringify(raw)
  }
}

/**
 * Rewrite a single `key = value` line in a TOML document, leaving everything
 * else — comments, ordering, other sections — byte for byte intact.
 */
export function setTomlKey(source: string, section: string, key: string, value: string): string {
  const lines = source.split('\n')
  let currentSection = ''
  let sectionHeaderIndex = -1

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const trimmed = line.trim()

    if (trimmed.startsWith('[')) {
      currentSection = trimmed.slice(1, -1).trim()
      if (currentSection === section && sectionHeaderIndex === -1) sectionHeaderIndex = i
      continue
    }

    if (currentSection === section) {
      const match = /^([A-Za-z0-9_-]+)\s*=/.exec(trimmed)
      if (match && match[1] === key) {
        lines[i] = line.replace(
          /(^[ \t]*[A-Za-z0-9_-]+\s*=\s*).*$/,
          (_all, head: string) => `${head}${value}`,
        )
        return lines.join('\n')
      }
    }
  }

  if (sectionHeaderIndex !== -1) {
    lines.splice(sectionHeaderIndex + 1, 0, `${key} = ${value}`)
  } else {
    const prefix = lines.join('\n').endsWith('\n') ? '' : '\n'
    lines.push(`${prefix}[${section}]`, `${key} = ${value}`)
  }

  return lines.join('\n')
}

export function readConfigValue(
  source: string,
  section: string,
  key: string,
): { found: boolean; value: unknown } {
  const sectionValues = parseToml(source)[section]
  if (!sectionValues || !(key in sectionValues)) return { found: false, value: undefined }
  return { found: true, value: sectionValues[key] }
}

/**
 * Validate and write a new value. The change is validated against the shared
 * schema before the file is touched.
 */
export async function setConfigValue(
  path: string,
  section: string,
  key: string,
  rawValue: string,
  force = false,
): Promise<void> {
  const field = fieldFor(section, key)
  if (!field) {
    const known = configFields()
      .map((candidate) => `${candidate.section}.${candidate.key}`)
      .join(', ')
    throw new ConfigError(`unknown key: ${section}.${key}`, `Known keys: ${known}`)
  }

  if (field.protected && !force) {
    throw new ConfigError(
      `${section}.${key} is not editable without --force`,
      'Changing it can orphan encrypted secrets or invalidate paired devices.',
    )
  }

  const source = await readFile(path, 'utf8')
  const value = formatTomlValue(field.type, rawValue)
  const updated = setTomlKey(source, section, key, value)

  const parsed = serverConfig.safeParse(fromToml(parseToml(updated)))
  if (!parsed.success) {
    throw new ConfigError(`${section}.${key} = ${rawValue} is not valid: ${parsed.error.message}`)
  }

  await writeFile(path, updated)
}

/** Effective values for `config show`, driven by the shared schema. */
export function effectiveValues(
  config: ServerConfig,
): Array<{ key: string; value: unknown; protected: boolean }> {
  return configFields().map((field) => {
    const section = (config as Record<string, Record<string, unknown>>)[field.section]
    return {
      key: `${field.section}.${field.key}`,
      value: section?.[field.schemaKey],
      protected: field.protected,
    }
  })
}

/** Hide the password that lives in `database.url`. The username stays visible. */
export function redactDatabaseUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.password) parsed.password = '***'
    return parsed.toString()
  } catch {
    return url
  }
}

export function formatConfigValue(value: unknown): string {
  if (value === undefined) return '(unset)'
  if (typeof value === 'string') return value
  return String(value)
}
