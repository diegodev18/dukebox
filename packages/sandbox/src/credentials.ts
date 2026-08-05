import { createServer, type Server } from 'node:net'
import { constants } from 'node:fs'
import { access, chmod, mkdir, rm } from 'node:fs/promises'
import { dirname } from 'node:path'

/**
 * Git credentials for session containers.
 *
 * The GitHub token belongs to the user's own account and can reach every
 * repository they own. Putting it inside a container where an autonomous agent
 * runs would hand that agent the lot: it could read the token out of the
 * environment, clone unrelated repositories, or push anywhere.
 *
 * Instead the token stays on the host. The container gets a credential helper
 * pointing at a Unix socket, and every request is checked against the one
 * repository that session is allowed to touch. A compromised agent can ask,
 * and be told no.
 */

/**
 * Where the credential socket appears inside the container.
 *
 * The *directory* is mounted, not the socket file: binding a socket directly
 * carries host permissions through inconsistently, and the container's non-root
 * user is then refused.
 *
 * This requires the host and the Docker daemon to share a kernel, which they do
 * on the Linux VPS this runs on. They do not under Docker Desktop on macOS,
 * where its file-sharing layer rejects Unix sockets outright (ENOTSUP) — so the
 * git-side tests cannot run there. See credentials.integration.test.ts.
 */
export const CONTAINER_SOCKET_DIR = '/run/dukebox'
export const CONTAINER_SOCKET_PATH = `${CONTAINER_SOCKET_DIR}/credentials.sock`

/**
 * The helper script installed in the container.
 *
 * Git calls a credential helper with an operation (get, store, erase) and
 * writes `key=value` lines to its stdin, terminated by a blank line. Only
 * `get` is answered: a session has nothing to store, and erasing a credential
 * the container never held is meaningless.
 *
 * Written in Node rather than shelling out to netcat, which is not in the base
 * image — and adding a general-purpose network tool to a container that runs an
 * autonomous agent is not a trade worth making for one socket read.
 */
export const HELPER_SCRIPT = `#!/bin/sh
# Installed by Dukebox. Asks the host for credentials over a Unix socket; the
# token itself never exists inside this container.
[ "$1" = "get" ] || exit 0
exec node -e '
const net = require("net");
let input = "";
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  const socket = net.connect(${JSON.stringify(CONTAINER_SOCKET_PATH)}, () => socket.end(input));
  socket.on("data", (chunk) => process.stdout.write(chunk));
  socket.on("error", () => process.exit(1));
});
'
`

export interface CredentialRequest {
  protocol?: string
  host?: string
  path?: string
}

export interface CredentialProxyOptions {
  /** Host filesystem path for the socket. Mounted into the container. */
  socketPath: string
  /**
   * Decide whether to answer a request, and with what.
   *
   * Returning null denies it: git then fails the operation, which is the
   * intended outcome for a repository this session has no business touching.
   */
  resolve: (request: CredentialRequest) => Promise<Credentials | null>
  /**
   * Called when resolving throws.
   *
   * Git only understands a credential or a refusal, so the reason for a
   * failure cannot travel back over the socket. Without this it is lost
   * entirely, and an expired token looks exactly like a repository that was
   * denied on purpose.
   */
  onError?: (error: Error) => void
}

export interface Credentials {
  username: string
  password: string
}

/** Parse git's credential protocol: `key=value` lines, blank line to end. */
export function parseCredentialRequest(input: string): CredentialRequest {
  const request: CredentialRequest = {}

  for (const line of input.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') break

    const separator = trimmed.indexOf('=')
    if (separator === -1) continue

    const key = trimmed.slice(0, separator)
    const value = trimmed.slice(separator + 1)

    if (key === 'protocol' || key === 'host' || key === 'path') {
      request[key] = value
    }
  }

  return request
}

/** Format a reply in the same protocol. */
export function formatCredentials(credentials: Credentials): string {
  return `username=${credentials.username}\npassword=${credentials.password}\n\n`
}

/**
 * Whether a request is for the repository this session owns.
 *
 * Compared case-insensitively and without the `.git` suffix, because git
 * presents the path in whichever form the remote URL used.
 */
export function matchesRepository(request: CredentialRequest, repoFullName: string): boolean {
  if (request.host?.toLowerCase() !== 'github.com') return false

  const requested = (request.path ?? '')
    .replace(/^\/+/, '')
    .replace(/\.git$/, '')
    .toLowerCase()
  return requested === repoFullName.toLowerCase()
}

/**
 * A Unix socket that answers git credential requests.
 *
 * One per session, so a request carries its authorization implicitly: the
 * socket a container can reach is the one scoped to its own repository.
 */
export class CredentialProxy {
  private server: Server | undefined

  constructor(private readonly options: CredentialProxyOptions) {}

  async start(): Promise<void> {
    if (this.server) throw new Error('credential proxy already started')

    const directory = dirname(this.options.socketPath)
    await mkdir(directory, { recursive: true })

    // A leftover socket from a crashed process would block the bind. `force`
    // hides a missing file but not a directory this process cannot write to,
    // which is its own failure and is reported below rather than here.
    await rm(this.options.socketPath, { force: true }).catch(() => undefined)

    // Docker creates a mount point as root. When the daemon made this
    // directory to mount it into a container, a service running as anyone else
    // cannot bind inside it — and `listen` reports that as a bare EACCES on a
    // path, with nothing about whose it is or what to do.
    await access(directory, constants.W_OK).catch(() => {
      throw new Error(
        `cannot create a credential socket in ${directory}: the directory is not writable by this process. ` +
          `It is usually owned by root because Docker created it as a mount point. ` +
          `Removing it lets the next session recreate it: sudo rm -rf ${directory}`,
      )
    })

    const server = createServer((socket) => {
      let input = ''

      socket.on('data', (chunk: Buffer) => {
        input += chunk.toString()

        // Git signals the end of a request with a blank line.
        if (!input.includes('\n\n')) return

        void this.answer(input).then((reply) => {
          socket.end(reply)
        })
      })

      // A hung client would otherwise hold the connection open indefinitely.
      socket.setTimeout(5000, () => socket.destroy())
      socket.on('error', () => socket.destroy())
    })

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(this.options.socketPath, () => resolve())
    })

    // The container runs as a different uid than the host process that owns
    // this socket, so it has to be world-writable to be usable at all. This is
    // safe because the socket answers for exactly one repository, and only
    // this session's container has it mounted.
    await chmod(this.options.socketPath, 0o666)

    this.server = server
  }

  private async answer(input: string): Promise<string> {
    const request = parseCredentialRequest(input)

    try {
      const credentials = await this.options.resolve(request)
      // An empty reply is how a helper declines. Git then reports an
      // authentication failure, which is what should happen for a repository
      // this session is not allowed to reach.
      return credentials ? formatCredentials(credentials) : '\n'
    } catch (error) {
      // Declining is the only reply git understands, so the reason cannot be
      // sent back over this socket — a failure to read the token would
      // otherwise be indistinguishable from a repository that was refused on
      // purpose, and both surface as "authentication failed" much later.
      this.options.onError?.(error instanceof Error ? error : new Error(String(error)))
      return '\n'
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    this.server = undefined

    await new Promise<void>((resolve) => server.close(() => resolve()))
    await rm(this.options.socketPath, { force: true })
  }
}

/**
 * Build a proxy scoped to one repository.
 *
 * `readToken` is called per request rather than once at startup, so the token
 * is never held in memory longer than an in-flight request and a re-login on
 * the host takes effect immediately.
 */
export function createSessionCredentialProxy(options: {
  socketPath: string
  repoFullName: string
  readToken: () => Promise<string>
  /** Surfaces a token that could not be read. See `CredentialProxyOptions`. */
  onError?: (error: Error) => void
}): CredentialProxy {
  return new CredentialProxy({
    socketPath: options.socketPath,
    ...(options.onError ? { onError: options.onError } : {}),
    resolve: async (request) => {
      if (!matchesRepository(request, options.repoFullName)) return null

      return {
        // GitHub ignores the username for token authentication, but git
        // requires one to be present.
        username: 'x-access-token',
        password: await options.readToken(),
      }
    },
  })
}
