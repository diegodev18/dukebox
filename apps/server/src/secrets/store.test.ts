import { projects, secrets } from '@dukebox/db'
import { randomBytes } from 'node:crypto'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { close, db, prepareDatabase, resetDatabase } from '../testing/database.js'
import { decrypt, encrypt, readMasterKey, SecretError, SecretStore } from './store.js'

const key = randomBytes(32)
const store = new SecretStore(db, key)

afterAll(() => close())
beforeAll(prepareDatabase)
beforeEach(resetDatabase)

async function writeKeyFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'dukebox-key-'))
  const path = join(dir, 'master.key')
  await writeFile(path, contents)
  return path
}

async function createProject(): Promise<string> {
  const [project] = await db
    .insert(projects)
    .values({ repoFullName: `diego/repo-${Math.random().toString(36).slice(2)}` })
    .returning()
  return project!.id
}

describe('encrypt and decrypt', () => {
  it('round-trips a value', () => {
    expect(decrypt(encrypt('secret value', key), key)).toBe('secret value')
  })

  it('round-trips text that is not ASCII', () => {
    expect(decrypt(encrypt('añade un comentario 日本語', key), key)).toBe(
      'añade un comentario 日本語',
    )
  })

  it('produces different ciphertext each time', () => {
    // A fresh IV per call, which GCM requires: reusing one leaks whether two
    // secrets are the same.
    const first = encrypt('same value', key)
    const second = encrypt('same value', key)

    expect(first.ciphertext).not.toBe(second.ciphertext)
    expect(first.iv).not.toBe(second.iv)
  })

  it('does not contain the plaintext', () => {
    const encrypted = encrypt('recognizable-secret', key)
    expect(JSON.stringify(encrypted)).not.toContain('recognizable-secret')
  })

  it('refuses a value encrypted with a different key', () => {
    expect(() => decrypt(encrypt('value', key), randomBytes(32))).toThrow(SecretError)
  })

  it('refuses ciphertext that was tampered with', () => {
    // GCM authenticates as well as encrypts, so a modified ciphertext fails
    // rather than decrypting to plausible garbage.
    const encrypted = encrypt('value', key)
    const flipped = Buffer.from(encrypted.ciphertext, 'base64')
    flipped[0] ^= 0xff

    expect(() => decrypt({ ...encrypted, ciphertext: flipped.toString('base64') }, key)).toThrow(
      SecretError,
    )
  })

  it('refuses a mismatched authentication tag', () => {
    const encrypted = encrypt('value', key)
    const other = encrypt('different', key)

    expect(() => decrypt({ ...encrypted, authTag: other.authTag }, key)).toThrow(SecretError)
  })

  it('explains that a changed master key is the likely cause', () => {
    // The failure an operator is most likely to hit, and the one where a
    // generic error would send them looking in the wrong place.
    expect(() => decrypt(encrypt('value', key), randomBytes(32))).toThrow(
      expect.objectContaining({ remedy: expect.stringContaining('master key') }),
    )
  })
})

describe('readMasterKey', () => {
  it('reads the key the installer writes', async () => {
    const path = await writeKeyFile(`${randomBytes(32).toString('base64')}\n`)
    expect((await readMasterKey(path)).length).toBe(32)
  })

  it('explains a missing key file', async () => {
    await expect(readMasterKey('/nonexistent/master.key')).rejects.toMatchObject({
      message: expect.stringContaining('no master key'),
      remedy: expect.stringContaining('installer'),
    })
  })

  it('refuses a key of the wrong length rather than deriving one', async () => {
    // Silently stretching a short key would produce something that works but
    // is far weaker than it looks.
    const path = await writeKeyFile(Buffer.from('too short').toString('base64'))
    await expect(readMasterKey(path)).rejects.toThrow(SecretError)
  })

  it('warns that regenerating the key loses every stored secret', async () => {
    const path = await writeKeyFile('x')
    await expect(readMasterKey(path)).rejects.toMatchObject({
      remedy: expect.stringContaining('unreadable'),
    })
  })
})

describe('SecretStore', () => {
  it('stores and reads a server-wide secret', async () => {
    await store.set('CLAUDE_CODE_OAUTH_TOKEN', 'sk-ant-oat-abc')
    expect(await store.get('CLAUDE_CODE_OAUTH_TOKEN')).toBe('sk-ant-oat-abc')
  })

  it('returns null for a secret that was never set', async () => {
    expect(await store.get('NOT_SET')).toBeNull()
  })

  it('never writes the plaintext to the database', async () => {
    await store.set('TOKEN', 'sk-ant-oat-supersecret')

    // A database dump on its own must be useless without the master key.
    const [row] = await db.select().from(secrets)
    expect(JSON.stringify(row)).not.toContain('sk-ant-oat-supersecret')
  })

  it('replaces an existing secret rather than adding a second', async () => {
    await store.set('TOKEN', 'first')
    await store.set('TOKEN', 'second')

    expect(await store.get('TOKEN')).toBe('second')
    expect(await db.select().from(secrets)).toHaveLength(1)
  })

  it('keeps project secrets separate from server-wide ones', async () => {
    const projectId = await createProject()

    await store.set('TOKEN', 'server-wide')
    await store.set('TOKEN', 'project-specific', projectId)

    expect(await store.get('TOKEN')).toBe('server-wide')
    expect(await store.get('TOKEN', projectId)).toBe('project-specific')
  })

  it('keeps two projects separate', async () => {
    const first = await createProject()
    const second = await createProject()

    await store.set('DATABASE_URL', 'postgres://first', first)
    await store.set('DATABASE_URL', 'postgres://second', second)

    expect(await store.get('DATABASE_URL', first)).toBe('postgres://first')
    expect(await store.get('DATABASE_URL', second)).toBe('postgres://second')
  })

  it('allows only one server-wide secret per name', async () => {
    // Postgres treats every null as distinct, so the ordinary unique index
    // cannot constrain these; a partial index is what actually does.
    await store.set('TOKEN', 'value')

    await expect(
      db.insert(secrets).values({
        name: 'TOKEN',
        projectId: null,
        ciphertext: 'x',
        iv: 'y',
        authTag: 'z',
      }),
    ).rejects.toThrow()
  })

  describe('has', () => {
    it('reports a stored secret without decrypting it', async () => {
      await store.set('TOKEN', 'value')
      expect(await store.has('TOKEN')).toBe(true)
    })

    it('reports one that was never set', async () => {
      expect(await store.has('TOKEN')).toBe(false)
    })
  })

  describe('delete', () => {
    it('removes a secret', async () => {
      await store.set('TOKEN', 'value')

      expect(await store.delete('TOKEN')).toBe(true)
      expect(await store.get('TOKEN')).toBeNull()
    })

    it('reports deleting one that does not exist', async () => {
      expect(await store.delete('TOKEN')).toBe(false)
    })

    it('leaves a project secret of the same name alone', async () => {
      const projectId = await createProject()
      await store.set('TOKEN', 'server-wide')
      await store.set('TOKEN', 'project', projectId)

      await store.delete('TOKEN')

      expect(await store.get('TOKEN', projectId)).toBe('project')
    })
  })

  describe('environmentFor', () => {
    it('returns a project secrets as environment variables', async () => {
      const projectId = await createProject()
      await store.set('DATABASE_URL', 'postgres://localhost', projectId)
      await store.set('API_KEY', 'key-123', projectId)

      expect(await store.environmentFor(projectId)).toEqual({
        DATABASE_URL: 'postgres://localhost',
        API_KEY: 'key-123',
      })
    })

    it('excludes server-wide secrets, so a project cannot shadow one', async () => {
      const projectId = await createProject()
      await store.set('CLAUDE_CODE_OAUTH_TOKEN', 'the-real-token')

      expect(await store.environmentFor(projectId)).toEqual({})
    })

    it('returns nothing for a project with no secrets', async () => {
      expect(await store.environmentFor(await createProject())).toEqual({})
    })
  })

  describe('names', () => {
    it('lists what is configured without revealing values', async () => {
      await store.set('B_TOKEN', 'value')
      await store.set('A_TOKEN', 'value')

      expect(await store.names()).toEqual(['A_TOKEN', 'B_TOKEN'])
    })

    it('lists a project secrets separately', async () => {
      const projectId = await createProject()
      await store.set('SERVER_WIDE', 'value')
      await store.set('PROJECT_ONLY', 'value', projectId)

      expect(await store.names()).toEqual(['SERVER_WIDE'])
      expect(await store.names(projectId)).toEqual(['PROJECT_ONLY'])
    })
  })

  describe('open', () => {
    it('builds a store from a key file', async () => {
      const path = await writeKeyFile(randomBytes(32).toString('base64'))
      const opened = await SecretStore.open(db, path)

      await opened.set('TOKEN', 'value')
      expect(await opened.get('TOKEN')).toBe('value')
    })
  })
})
