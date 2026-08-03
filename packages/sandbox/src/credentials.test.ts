import { connect } from 'node:net'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CredentialProxy,
  createSessionCredentialProxy,
  formatCredentials,
  matchesRepository,
  parseCredentialRequest,
} from './credentials.js'

describe('parseCredentialRequest', () => {
  it('reads the fields git sends', () => {
    expect(
      parseCredentialRequest('protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n'),
    ).toEqual({ protocol: 'https', host: 'github.com', path: 'diego/dukebox.git' })
  })

  it('stops at the blank line that ends a request', () => {
    const parsed = parseCredentialRequest('host=github.com\n\nhost=evil.com\n')
    expect(parsed.host).toBe('github.com')
  })

  it('ignores fields it does not use', () => {
    const parsed = parseCredentialRequest('host=github.com\nwwwauth[]=Basic\n\n')
    expect(parsed).toEqual({ host: 'github.com' })
  })

  it('keeps a value containing an equals sign intact', () => {
    expect(parseCredentialRequest('path=a=b\n\n').path).toBe('a=b')
  })

  it('returns nothing for empty input', () => {
    expect(parseCredentialRequest('')).toEqual({})
  })
})

describe('formatCredentials', () => {
  it('writes the reply git expects, ending with a blank line', () => {
    expect(formatCredentials({ username: 'x-access-token', password: 'secret' })).toBe(
      'username=x-access-token\npassword=secret\n\n',
    )
  })
})

describe('matchesRepository', () => {
  const request = { protocol: 'https', host: 'github.com', path: 'diego/dukebox.git' }

  it('accepts the session repository', () => {
    expect(matchesRepository(request, 'diego/dukebox')).toBe(true)
  })

  it('accepts a path without the .git suffix', () => {
    expect(matchesRepository({ ...request, path: 'diego/dukebox' }, 'diego/dukebox')).toBe(true)
  })

  it('accepts a leading slash, which git sometimes includes', () => {
    expect(matchesRepository({ ...request, path: '/diego/dukebox' }, 'diego/dukebox')).toBe(true)
  })

  it('ignores case, since GitHub does', () => {
    expect(matchesRepository({ ...request, path: 'Diego/Dukebox' }, 'diego/dukebox')).toBe(true)
  })

  it('refuses a different repository', () => {
    // The reason this proxy exists: a compromised agent must not be able to
    // borrow the token for anything but its own session's repository.
    expect(matchesRepository({ ...request, path: 'diego/secrets.git' }, 'diego/dukebox')).toBe(
      false,
    )
  })

  it('refuses another owner', () => {
    expect(matchesRepository({ ...request, path: 'someone/dukebox' }, 'diego/dukebox')).toBe(false)
  })

  it('refuses a different host', () => {
    expect(matchesRepository({ ...request, host: 'evil.com' }, 'diego/dukebox')).toBe(false)
  })

  it('refuses a request with no path', () => {
    expect(matchesRepository({ host: 'github.com' }, 'diego/dukebox')).toBe(false)
  })

  it('refuses a path that merely starts with the repository name', () => {
    expect(matchesRepository({ ...request, path: 'diego/dukebox-secrets' }, 'diego/dukebox')).toBe(
      false,
    )
  })
})

describe('CredentialProxy', () => {
  const proxies: CredentialProxy[] = []
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(proxies.map((proxy) => proxy.stop()))
    proxies.length = 0

    await Promise.all(directories.map((dir) => rm(dir, { recursive: true, force: true })))
    directories.length = 0
  })

  async function socketPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dukebox-cred-'))
    directories.push(dir)
    return join(dir, 'credentials.sock')
  }

  /** Speak git's credential protocol over the socket, as the helper does. */
  async function ask(path: string, request: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const socket = connect(path, () => socket.end(request))

      let reply = ''
      socket.on('data', (chunk: Buffer) => {
        reply += chunk.toString()
      })
      socket.on('end', () => resolve(reply))
      socket.on('error', reject)
    })
  }

  async function startProxy(repoFullName: string, readToken = async () => 'gho_token') {
    const path = await socketPath()
    const proxy = createSessionCredentialProxy({ socketPath: path, repoFullName, readToken })
    proxies.push(proxy)
    await proxy.start()
    return { proxy, path }
  }

  it('answers a request for the session repository', async () => {
    const { path } = await startProxy('diego/dukebox')

    const reply = await ask(path, 'protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n')

    expect(reply).toContain('password=gho_token')
    expect(reply).toContain('username=x-access-token')
  })

  it('declines a request for a different repository', async () => {
    const { path } = await startProxy('diego/dukebox')

    // The whole point: an agent that goes looking for another repository gets
    // an authentication failure, not the user's token.
    const reply = await ask(path, 'protocol=https\nhost=github.com\npath=diego/private.git\n\n')

    expect(reply).not.toContain('password')
    expect(reply.trim()).toBe('')
  })

  it('never sends the token when declining', async () => {
    const { path } = await startProxy('diego/dukebox', async () => 'gho_supersecret')

    const reply = await ask(path, 'protocol=https\nhost=github.com\npath=other/repo.git\n\n')

    expect(reply).not.toContain('gho_supersecret')
  })

  it('reads the token per request, so a host re-login takes effect at once', async () => {
    const readToken = vi.fn(async () => 'gho_token')
    const { path } = await startProxy('diego/dukebox', readToken)

    const request = 'protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n'
    await ask(path, request)
    await ask(path, request)

    // Also means the token is not held in memory between requests.
    expect(readToken).toHaveBeenCalledTimes(2)
  })

  it('declines rather than failing when the token cannot be read', async () => {
    const { path } = await startProxy('diego/dukebox', async () => {
      throw new Error('gh is not logged in')
    })

    const reply = await ask(path, 'protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n')
    expect(reply.trim()).toBe('')
  })

  it('keeps serving after a declined request', async () => {
    const { path } = await startProxy('diego/dukebox')

    await ask(path, 'protocol=https\nhost=github.com\npath=other/repo.git\n\n')
    const reply = await ask(path, 'protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n')

    expect(reply).toContain('password=gho_token')
  })

  it('makes the socket reachable by the container, which runs as another user', async () => {
    const { path } = await startProxy('diego/dukebox')
    const info = await stat(path)

    // The container's uid differs from the host process that owns the socket.
    // Safe because this socket answers for exactly one repository.
    expect(info.mode & 0o666).toBe(0o666)
  })

  it('replaces a socket left behind by a crashed process', async () => {
    const path = await socketPath()

    const first = createSessionCredentialProxy({
      socketPath: path,
      repoFullName: 'diego/dukebox',
      readToken: async () => 'token',
    })
    await first.start()
    // Simulates a crash: the file is still there, but nothing is listening.
    proxies.push(first)

    const second = createSessionCredentialProxy({
      socketPath: path,
      repoFullName: 'diego/dukebox',
      readToken: async () => 'token',
    })
    proxies.push(second)

    await expect(second.start()).resolves.toBeUndefined()
  })

  it('refuses to start twice', async () => {
    const { proxy } = await startProxy('diego/dukebox')
    await expect(proxy.start()).rejects.toThrow('already started')
  })

  it('removes the socket when stopped', async () => {
    const { proxy, path } = await startProxy('diego/dukebox')
    await proxy.stop()

    await expect(stat(path)).rejects.toThrow()
  })

  it('tolerates being stopped twice', async () => {
    const { proxy } = await startProxy('diego/dukebox')
    await proxy.stop()
    await expect(proxy.stop()).resolves.toBeUndefined()
  })
})
