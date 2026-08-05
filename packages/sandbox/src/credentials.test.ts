import { spawn } from 'node:child_process'
import { connect, createServer } from 'node:net'
import { chmod, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  CONTAINER_SOCKET_PATH,
  CredentialProxy,
  createSessionCredentialProxy,
  formatCredentials,
  HELPER_SCRIPT,
  matchesRepository,
  parseCredentialRequest,
} from './credentials.js'

/**
 * The helper as git actually invokes it.
 *
 * git writes the request, then waits with the pipe still open. A helper that
 * waits for stdin to close waits for something that only happens after git has
 * given up, and git reports that as "could not read Username … No such device
 * or address" — naming neither the helper nor the socket.
 */
describe('HELPER_SCRIPT', () => {
  const cleanup: string[] = []

  afterEach(async () => {
    await Promise.all(cleanup.map((path) => rm(path, { recursive: true, force: true })))
    cleanup.length = 0
  })

  /** Run the helper against a socket that answers, without closing its stdin. */
  async function askHelper(request: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'dukebox-helper-'))
    cleanup.push(dir)

    const socketPath = join(dir, 'credentials.sock')
    const server = createServer((socket) => {
      let input = ''
      socket.on('data', (chunk: Buffer) => {
        input += chunk.toString()
        if (input.includes('\n\n')) socket.end('username=x-access-token\npassword=secret\n')
      })
    })

    await new Promise<void>((resolve) => server.listen(socketPath, resolve))

    const helperPath = join(dir, 'helper')
    await writeFile(helperPath, HELPER_SCRIPT.replace(CONTAINER_SOCKET_PATH, socketPath))
    await chmod(helperPath, 0o755)

    try {
      return await new Promise<string>((resolve, reject) => {
        const child = spawn(helperPath, ['get'], { stdio: ['pipe', 'pipe', 'ignore'] })

        let output = ''
        child.stdout.on('data', (chunk: Buffer) => {
          output += chunk.toString()
        })

        child.on('close', () => resolve(output))
        child.on('error', reject)

        // Written and then left open, which is what git does.
        child.stdin.write(request)

        const timer = setTimeout(() => {
          child.kill()
          reject(new Error('the helper never answered'))
        }, 5000)
        child.on('close', () => clearTimeout(timer))
      })
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  it('answers without waiting for stdin to close', async () => {
    const reply = await askHelper('protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n')
    expect(reply).toContain('password=secret')
  })

  it('does nothing for an operation other than get', async () => {
    // git also calls helpers to store and erase. Answering those would be
    // meaningless here, and hanging on them would stall the operation.
    const dir = await mkdtemp(join(tmpdir(), 'dukebox-helper-'))
    cleanup.push(dir)

    const helperPath = join(dir, 'helper')
    await writeFile(helperPath, HELPER_SCRIPT)
    await chmod(helperPath, 0o755)

    const code = await new Promise<number | null>((resolve) => {
      const child = spawn(helperPath, ['store'], { stdio: ['pipe', 'ignore', 'ignore'] })
      child.stdin.end('protocol=https\nhost=github.com\n\n')
      child.on('close', resolve)
    })

    expect(code).toBe(0)
  })
})

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

  it('explains an unwritable directory rather than passing EACCES through', async ({ skip }) => {
    // Docker creates a mount point as root, so a service running as anyone
    // else cannot bind inside it. `listen` reports that as a bare EACCES on a
    // path, which says nothing about whose directory it is or how to fix it.
    //
    // Root ignores permission bits, so this can only be checked as a normal
    // user. Skipped rather than quietly passing where it proves nothing.
    if (typeof process.getuid === 'function' && process.getuid() === 0) {
      skip('permission bits do not apply to root')
      return
    }

    const dir = await mkdtemp(join(tmpdir(), 'dukebox-cred-'))
    directories.push(dir)

    const locked = join(dir, 'locked')
    await mkdir(locked)
    await chmod(locked, 0o500)

    const proxy = createSessionCredentialProxy({
      socketPath: join(locked, 'credentials.sock'),
      repoFullName: 'diego/dukebox',
      readToken: async () => 'token',
    })

    await expect(proxy.start()).rejects.toThrow(/not writable by this process/)

    // Restored so the directory can be cleaned up.
    await chmod(locked, 0o700)
  })

  it('reports a token it could not read instead of only declining', async () => {
    // git understands a credential or a refusal, nothing else, so the reason
    // has to leave by another door or an expired token looks exactly like a
    // repository denied on purpose.
    const errors: Error[] = []
    const path = await socketPath()

    const proxy = createSessionCredentialProxy({
      socketPath: path,
      repoFullName: 'diego/dukebox',
      readToken: async () => {
        throw new Error('gh auth token failed: not logged in')
      },
      onError: (error) => errors.push(error),
    })
    proxies.push(proxy)
    await proxy.start()

    const reply = await ask(path, 'protocol=https\nhost=github.com\npath=diego/dukebox.git\n\n')

    // Still declines, because that is the only thing git can act on.
    expect(reply.trim()).toBe('')
    expect(errors[0]?.message).toContain('not logged in')
  })

  it('stays quiet when a repository is refused on purpose', async () => {
    // A denied repository is the proxy working, not a fault to report.
    const errors: Error[] = []
    const path = await socketPath()

    const proxy = createSessionCredentialProxy({
      socketPath: path,
      repoFullName: 'diego/dukebox',
      readToken: async () => 'token',
      onError: (error) => errors.push(error),
    })
    proxies.push(proxy)
    await proxy.start()

    await ask(path, 'protocol=https\nhost=github.com\npath=someone/else.git\n\n')

    expect(errors).toHaveLength(0)
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
