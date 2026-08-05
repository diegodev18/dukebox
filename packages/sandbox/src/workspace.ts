import type { AgentEvent } from '@dukebox/protocol'
import type { SessionContainer } from './container.js'
import { HELPER_SCRIPT } from './credentials.js'

/**
 * Repository setup and diffing inside a session container.
 *
 * Diffs are computed from git rather than from the agent's own tool results.
 * An agent can change a file by editing it, redirecting shell output into it,
 * running a formatter, or applying a patch — asking git what changed is the
 * only way to see all of it.
 */

export const WORKSPACE_DIR = '/workspace/repo'

/** Branch name for a session. Namespaced so it is obvious who created it. */
export function sessionBranch(sessionId: string): string {
  // Short prefix keeps it readable in GitHub's UI; the session id is a uuid
  // and collisions within one repository are not a practical concern.
  return `duke/${sessionId.slice(0, 8)}`
}

export class WorkspaceError extends Error {
  constructor(
    message: string,
    readonly stderr: string,
    readonly exitCode: number,
  ) {
    super(message)
    this.name = 'WorkspaceError'
  }
}

export interface CloneOptions {
  /** Clone URL. Credentials are supplied by the credential proxy, not here. */
  url: string
  baseBranch: string
  sessionId: string
  /**
   * Shallow clone depth. Agents rarely need history, and a full clone of a
   * large repository dominates session startup time.
   */
  depth?: number
}

export class Workspace {
  constructor(private readonly container: SessionContainer) {}

  /** Run a command, throwing with captured stderr if it fails. */
  private async run(
    command: string[],
    options: { cwd?: string; env?: Record<string, string> } = {},
  ) {
    const result = await this.container.exec(command, { cwd: WORKSPACE_DIR, ...options })

    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        `command failed: ${command.join(' ')}`,
        result.stderr || result.stdout,
        result.exitCode,
      )
    }

    return result
  }

  /** Path to the credential helper inside the container. */
  /** Where the credential helper is installed. Public so failures can name it. */
  static readonly HELPER_PATH = '/home/node/.dukebox/credential-helper'

  /**
   * Install the git credential helper.
   *
   * Must run before any git operation that talks to a remote. The helper asks
   * the host for credentials over a Unix socket; no token is written into the
   * container, so an agent reading its own filesystem finds nothing to steal.
   */
  async installCredentialHelper(): Promise<void> {
    // Transferred base64-encoded. The script contains quotes, newlines and
    // dollar signs, and every attempt to pass it through a shell literal ends
    // up mangling one of them — a helper written as a single line with literal
    // \n in it is not executable, and fails only when git first needs a
    // credential.
    const encoded = Buffer.from(HELPER_SCRIPT, 'utf8').toString('base64')

    const result = await this.container.exec([
      'sh',
      '-c',
      `mkdir -p "$(dirname ${Workspace.HELPER_PATH})" &&
       echo '${encoded}' | base64 -d > ${Workspace.HELPER_PATH} &&
       chmod +x ${Workspace.HELPER_PATH} &&
       git config --global credential.helper ${Workspace.HELPER_PATH}`,
    ])

    if (result.exitCode !== 0) {
      throw new WorkspaceError(
        'failed to install the git credential helper',
        result.stderr,
        result.exitCode,
      )
    }
  }

  /**
   * Clone the repository and check out a fresh branch for this session.
   *
   * The agent never commits to the base branch: work lands on its own branch
   * and reaches the user as a pull request they review.
   */
  async clone(options: CloneOptions): Promise<{ branch: string }> {
    const branch = sessionBranch(options.sessionId)

    await this.container.exec(['mkdir', '-p', WORKSPACE_DIR], { cwd: '/workspace' })

    await this.run([
      'git',
      'clone',
      '--depth',
      String(options.depth ?? 1),
      '--branch',
      options.baseBranch,
      options.url,
      WORKSPACE_DIR,
    ])

    await this.run(['git', 'checkout', '-b', branch])

    return { branch }
  }

  /**
   * The commit the session branch grew from.
   *
   * Recovered from the remote-tracking ref rather than remembered, for
   * sessions that started before the base commit was persisted. `HEAD` is not
   * a substitute: it is the agent's own latest commit, so measuring against it
   * reports that nothing changed no matter how much did.
   *
   * Returns null when the ref is missing, which is the honest answer — a wrong
   * base is worse than no base, because it silently hides work.
   */
  async baseCommitFromRemote(baseBranch: string): Promise<string | null> {
    // `exec` rather than `run`: a missing ref is an answer, not a failure.
    const result = await this.container.exec(['git', 'rev-parse', `origin/${baseBranch}`], {
      cwd: WORKSPACE_DIR,
    })

    const commit = result.stdout.trim()
    return result.exitCode === 0 && commit !== '' ? commit : null
  }

  /**
   * Run the project's setup commands.
   *
   * Each runs through a shell because `.duke/config.yaml` contains command
   * lines, not argument vectors: `pnpm install && pnpm build` has to work.
   */
  async runSetup(commands: string[], env: Record<string, string> = {}): Promise<void> {
    for (const command of commands) {
      await this.run(['sh', '-c', command], { env })
    }
  }

  /** Current HEAD commit, recorded so diffs have a stable base. */
  async headCommit(): Promise<string> {
    const result = await this.run(['git', 'rev-parse', 'HEAD'])
    return result.stdout.trim()
  }

  /**
   * Paths changed since `baseCommit`, including untracked files.
   *
   * `git diff --name-only` alone misses files the agent created, which are
   * usually the most interesting ones.
   */
  async changedFiles(baseCommit: string): Promise<string[]> {
    const tracked = await this.run(['git', 'diff', '--name-only', baseCommit])
    const untracked = await this.run(['git', 'ls-files', '--others', '--exclude-standard'])

    const paths = new Set(
      [...splitLines(tracked.stdout), ...splitLines(untracked.stdout)].filter(Boolean),
    )

    return [...paths].sort()
  }

  /**
   * Contents of a path at a commit, or null if it did not exist.
   *
   * A missing path is how file creation is represented, so it is an expected
   * result rather than an error.
   */
  async fileAtCommit(commit: string, path: string): Promise<string | null> {
    const result = await this.container.exec(['git', 'show', `${commit}:${path}`], {
      cwd: WORKSPACE_DIR,
    })

    return result.exitCode === 0 ? result.stdout : null
  }

  /** Current working-tree contents of a path, or null if it was deleted. */
  async currentFile(path: string): Promise<string | null> {
    const result = await this.container.exec(['cat', path], { cwd: WORKSPACE_DIR })
    return result.exitCode === 0 ? result.stdout : null
  }

  /**
   * Build `file_diff` events for everything changed since `baseCommit`.
   *
   * Emitted after each turn so the desktop diff panel reflects the workspace
   * exactly, whatever the agent did to get there.
   */
  async diffEvents(baseCommit: string): Promise<AgentEvent[]> {
    const paths = await this.changedFiles(baseCommit)

    const events = await Promise.all(
      paths.map(async (path): Promise<AgentEvent> => {
        const [before, after] = await Promise.all([
          this.fileAtCommit(baseCommit, path),
          this.currentFile(path),
        ])

        return { type: 'file_diff', path, before, after }
      }),
    )

    // A path can appear changed while its contents are identical — a file
    // touched and reverted, or rewritten with the same bytes. Those are not
    // changes worth showing.
    return events.filter((event) => event.type !== 'file_diff' || event.before !== event.after)
  }

  /** Commit everything in the working tree. Returns null if nothing changed. */
  async commitAll(message: string): Promise<string | null> {
    await this.run(['git', 'add', '-A'])

    const status = await this.run(['git', 'status', '--porcelain'])
    if (status.stdout.trim() === '') return null

    await this.run(['git', 'commit', '-m', message])
    return this.headCommit()
  }

  /**
   * Whether the credential socket is reachable from inside the container.
   *
   * The host can hold a perfectly good socket that the container cannot see:
   * a bind mount is bound to the directory that existed when the container was
   * created, so a directory replaced since then leaves the mount pointing at
   * something gone. git reports that as "could not read Username … No such
   * device or address", which names neither the socket nor the mount.
   */
  async credentialSocketReachable(socketPath: string): Promise<boolean> {
    const result = await this.container.exec(['test', '-S', socketPath])
    return result.exitCode === 0
  }

  /** Push the session branch. Credentials come from the credential proxy. */
  async push(branch: string): Promise<void> {
    await this.run(['git', 'push', '--set-upstream', 'origin', branch])
  }

  /**
   * Why git could not authenticate, asked from inside the container.
   *
   * git's own failure names none of the things that can be wrong: whether a
   * helper is configured, whether the file exists, whether the socket is
   * mounted, whether the helper answers. Each has to be checked where git runs
   * — from outside, every one of them can look fine.
   */
  async diagnoseCredentials(
    helperPath: string,
    socketPath: string,
    repoFullName: string,
  ): Promise<string> {
    const checks: [string, string[]][] = [
      ['helper configured', ['git', 'config', '--global', '--get', 'credential.helper']],
      ['helper executable', ['test', '-x', helperPath]],
      ['socket present', ['test', '-S', socketPath]],
    ]

    const findings: string[] = []

    for (const [label, command] of checks) {
      const result = await this.container.exec(command, { cwd: WORKSPACE_DIR })
      const detail = result.stdout.trim()

      findings.push(
        result.exitCode === 0 ? `${label}: yes${detail ? ` (${detail})` : ''}` : `${label}: NO`,
      )
    }

    // The helper end to end, driven the way git drives it. This is the check
    // that distinguishes "everything is in place" from "it actually answers".
    const answered = await this.container.exec([
      'sh',
      '-c',
      // The session's own repository. Asking for anything else is refused by
      // design, which would report the proxy working as a failure.
      `printf 'protocol=https\\nhost=github.com\\npath=${repoFullName}.git\\n\\n' | ${helperPath} get`,
    ])

    findings.push(
      answered.stdout.includes('password=')
        ? 'helper answers: yes'
        : `helper answers: NO (exit ${answered.exitCode})`,
    )

    return findings.join(', ')
  }
}

function splitLines(value: string): string[] {
  return value.split('\n').map((line) => line.trim())
}
