import { secrets, type Database } from '@dukebox/db'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { and, eq, isNull } from 'drizzle-orm'

/**
 * Encrypted secrets.
 *
 * Values are encrypted with a key the installer generated on the operator's own
 * machine and never leave the database in plaintext. A database dump on its own
 * is useless; recovering a secret needs the master key file too, which lives at
 * 0600 outside any backup this project takes.
 *
 * AES-256-GCM rather than CBC: it authenticates as well as encrypts, so a
 * tampered ciphertext fails to decrypt instead of yielding plausible garbage.
 */

/** Names Dukebox itself uses. Project secrets can be called anything. */
export const AGENT_CREDENTIAL_SECRET = 'CLAUDE_CODE_OAUTH_TOKEN'

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

export class SecretError extends Error {
  constructor(
    message: string,
    readonly remedy?: string,
  ) {
    super(message)
    this.name = 'SecretError'
  }
}

/**
 * Read the master key.
 *
 * The file holds base64 of 32 random bytes, as `openssl rand -base64 32`
 * writes it. Anything else is a configuration mistake worth failing loudly on
 * rather than deriving a key from.
 */
export async function readMasterKey(path: string): Promise<Buffer> {
  let contents: string
  try {
    contents = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT') {
      throw new SecretError(`no master key at ${path}`, 'Run the installer, which generates one.')
    }
    throw error
  }

  const key = Buffer.from(contents.trim(), 'base64')
  if (key.length !== 32) {
    throw new SecretError(
      `the master key at ${path} is ${key.length} bytes; 32 are required`,
      'Regenerating it makes every stored secret unreadable. Restore the original if you have it.',
    )
  }

  return key
}

export interface EncryptedValue {
  ciphertext: string
  iv: string
  authTag: string
}

/** Encrypt a value. A fresh IV per call, which GCM requires for safety. */
export function encrypt(value: string, key: Buffer): EncryptedValue {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)

  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])

  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
  }
}

/** Decrypt a value, or throw if it was tampered with or the key is wrong. */
export function decrypt(encrypted: EncryptedValue, key: Buffer): string {
  const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(encrypted.iv, 'base64'))
  decipher.setAuthTag(Buffer.from(encrypted.authTag, 'base64'))

  try {
    return Buffer.concat([
      decipher.update(Buffer.from(encrypted.ciphertext, 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    // GCM's authentication tag failing means the ciphertext, IV, or key does
    // not match — most often a master key that was regenerated.
    throw new SecretError(
      'could not decrypt a stored secret',
      'This usually means the master key changed. Set the secret again.',
    )
  }
}

export class SecretStore {
  constructor(
    private readonly db: Database,
    private readonly masterKey: Buffer,
  ) {}

  static async open(db: Database, masterKeyFile: string): Promise<SecretStore> {
    return new SecretStore(db, await readMasterKey(masterKeyFile))
  }

  /**
   * Store a secret, replacing any existing one with the same name.
   *
   * `projectId` null means server-wide — agent credentials, which the same
   * subscription serves for every session.
   */
  async set(name: string, value: string, projectId: string | null = null): Promise<void> {
    const encrypted = encrypt(value, this.masterKey)

    const existing = await this.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(this.matching(name, projectId))

    if (existing[0]) {
      await this.db
        .update(secrets)
        .set({ ...encrypted, updatedAt: new Date() })
        .where(eq(secrets.id, existing[0].id))
      return
    }

    await this.db.insert(secrets).values({ name, projectId, ...encrypted })
  }

  /** Read a secret, or null if it was never set. */
  async get(name: string, projectId: string | null = null): Promise<string | null> {
    const [row] = await this.db.select().from(secrets).where(this.matching(name, projectId))

    return row ? decrypt(row, this.masterKey) : null
  }

  /** Whether a secret exists, without decrypting it. */
  async has(name: string, projectId: string | null = null): Promise<boolean> {
    const [row] = await this.db
      .select({ id: secrets.id })
      .from(secrets)
      .where(this.matching(name, projectId))

    return row !== undefined
  }

  async delete(name: string, projectId: string | null = null): Promise<boolean> {
    const deleted = await this.db
      .delete(secrets)
      .where(this.matching(name, projectId))
      .returning({ id: secrets.id })

    return deleted.length > 0
  }

  /**
   * Every secret for a project, decrypted, as environment variables.
   *
   * Used when building a session container. Server-wide secrets are not
   * included: they are added separately, so a project cannot shadow one.
   */
  async environmentFor(projectId: string): Promise<Record<string, string>> {
    const rows = await this.db.select().from(secrets).where(eq(secrets.projectId, projectId))

    return Object.fromEntries(rows.map((row) => [row.name, decrypt(row, this.masterKey)]))
  }

  /** Names only, for a UI that lists what is configured without revealing it. */
  async names(projectId: string | null = null): Promise<string[]> {
    const rows = await this.db
      .select({ name: secrets.name })
      .from(secrets)
      .where(projectId === null ? isNull(secrets.projectId) : eq(secrets.projectId, projectId))

    return rows.map((row) => row.name).sort()
  }

  /**
   * Match one secret by name and scope.
   *
   * `is null` rather than `= null`: SQL comparisons against null are never
   * true, so an equality check would silently match nothing.
   */
  private matching(name: string, projectId: string | null) {
    return and(
      eq(secrets.name, name),
      projectId === null ? isNull(secrets.projectId) : eq(secrets.projectId, projectId),
    )
  }
}
