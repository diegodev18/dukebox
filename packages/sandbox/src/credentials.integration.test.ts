import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { Sandbox, type SessionContainer } from './container.js'
import {
  CONTAINER_SOCKET_DIR,
  CONTAINER_SOCKET_PATH,
  createSessionCredentialProxy,
  type CredentialProxy,
} from './credentials.js'
import { Workspace } from './workspace.js'

/**
 * The credential proxy driven by real git inside a real container.
 *
 * The unit tests prove the socket answers correctly. These prove git actually
 * uses it, and — the point of the whole design — that an agent asking for a
 * repository outside its session gets nothing.
 *
 * The git-side tests need the container to reach the socket, which requires the
 * host and the Docker daemon to share a kernel. That holds on the Linux VPS
 * this runs on. It does not hold under Docker Desktop on macOS, whose
 * file-sharing layer rejects Unix sockets outright (ENOTSUP), so those tests
 * skip themselves there with a printed reason.
 *
 * The containment checks — that the token is nowhere inside the container —
 * run everywhere, and they are the ones that would catch a leak.
 */

const sandbox = new Sandbox()
const image = process.env.DUKEBOX_TEST_IMAGE ?? 'dukebox/base-node:latest'
const SESSION_REPO = 'diego/dukebox'
const TOKEN = 'gho_thetokenthatmustnotescape'

let container: SessionContainer
let proxy: CredentialProxy
let socketDir: string

/**
 * Whether the daemon can see the socket we created.
 *
 * A bind source is resolved by the Docker daemon on the host, so a socket
 * inside this test container is invisible to it. Detected rather than assumed
 * so the same suite works both in the dev container and on a VPS.
 */
let socketIsMounted = false

beforeAll(async () => {
  // DUKEBOX_HOST_TMP names a directory shared with the daemon, when there is
  // one. Otherwise fall back to a local path and detect the outcome.
  const root = process.env.DUKEBOX_HOST_TMP ?? tmpdir()
  socketDir = await mkdtemp(join(root, 'dukebox-cred-int-'))
  const socketPath = join(socketDir, 'credentials.sock')

  proxy = createSessionCredentialProxy({
    socketPath,
    repoFullName: SESSION_REPO,
    readToken: async () => TOKEN,
  })
  await proxy.start()

  container = await sandbox.create({
    sessionId: randomUUID(),
    image,
    network: 'none',
    // The directory, not the socket file — see CONTAINER_SOCKET_DIR.
    mounts: [{ source: socketDir, target: CONTAINER_SOCKET_DIR }],
  })

  const probe = await container.exec(['test', '-S', CONTAINER_SOCKET_PATH])
  socketIsMounted = probe.exitCode === 0

  // Installed through the same call a real session makes, so this covers the
  // production path rather than a test-only copy of it.
  await new Workspace(container).installCredentialHelper()
}, 120_000)

afterAll(async () => {
  await container?.remove()
  await proxy?.stop()
  await rm(socketDir, { recursive: true, force: true })
})

/** Ask git for credentials the way it does before contacting a remote. */
async function askGitFor(path: string) {
  return container.exec([
    'sh',
    '-c',
    `printf 'protocol=https\\nhost=github.com\\npath=${path}\\n\\n' | git credential fill`,
  ])
}

describe('git credential helper', () => {
  /**
   * Skip at run time, with a reason.
   *
   * A suite that goes quiet when its subject is unreachable looks identical to
   * one that passed, so the skip is announced rather than silent.
   */
  function requireSocket(context: { skip: () => void }): boolean {
    if (socketIsMounted) return true

    console.warn(
      'skipping: the container cannot reach the credential socket. Under Docker ' +
        'Desktop on macOS this is expected — its file-sharing layer rejects Unix ' +
        'sockets (ENOTSUP). Run on Linux, where the host and the daemon share a ' +
        'kernel, to exercise these.',
    )
    context.skip()
    return false
  }

  it('supplies the token for the session repository', async (context) => {
    if (!requireSocket(context)) return

    const result = await askGitFor(`${SESSION_REPO}.git`)

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain(`password=${TOKEN}`)
  })

  it('supplies nothing for a different repository', async (context) => {
    if (!requireSocket(context)) return

    // An agent that goes looking for another of the user's repositories gets
    // no credential, and the clone or push fails.
    const result = await askGitFor('diego/private-notes.git')

    expect(result.stdout).not.toContain(TOKEN)
  })

  it('supplies nothing for another owner', async (context) => {
    if (!requireSocket(context)) return

    const result = await askGitFor('someone-else/repo.git')
    expect(result.stdout).not.toContain(TOKEN)
  })
})

describe('token containment', () => {
  it('is absent from the container environment', async () => {
    // The reason for all of this: an agent can read its own environment.
    const result = await container.exec(['sh', '-c', 'env'])
    expect(result.stdout).not.toContain(TOKEN)
  })

  it('is absent from the git configuration', async () => {
    const result = await container.exec(['sh', '-c', 'git config --list --show-origin'])
    expect(result.stdout).not.toContain(TOKEN)
  })

  it('is absent from the helper script the agent can read', async () => {
    const result = await container.exec(['cat', '/home/node/.dukebox/credential-helper'])

    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain(TOKEN)
  })

  it('is nowhere in the home directory', async () => {
    const result = await container.exec([
      'sh',
      '-c',
      `grep -rl ${TOKEN} /home/node 2>/dev/null || echo NOT_FOUND`,
    ])

    expect(result.stdout.trim()).toBe('NOT_FOUND')
  })

  it('leaves no credential cached after a successful request', async () => {
    await askGitFor(`${SESSION_REPO}.git`)

    // Nothing may persist it: the next request must go back through the proxy,
    // where it is checked again.
    const result = await container.exec([
      'sh',
      '-c',
      'cat /home/node/.git-credentials 2>/dev/null || echo NO_STORE',
    ])

    expect(result.stdout.trim()).toBe('NO_STORE')
  })
})
