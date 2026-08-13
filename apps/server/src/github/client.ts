import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { z } from 'zod'

const exec = promisify(execFile)

/**
 * GitHub, through the `gh` CLI on the host.
 *
 * Every API call happens here, in the control plane — never inside a session
 * container. The agent's only reach into GitHub is git itself, authenticated
 * through the credential proxy and scoped to one repository. That keeps the
 * blast radius of a compromised agent to the repository it was given, rather
 * than every repository the user owns.
 *
 * `gh` rather than raw HTTP because the user has already authenticated it, and
 * asking them to create a GitHub App for a self-hosted tool is friction that
 * would stop most people at the install step.
 */

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly remedy?: string,
  ) {
    super(message)
    this.name = 'GitHubError'
  }
}

const repository = z.object({
  nameWithOwner: z.string(),
  defaultBranchRef: z.object({ name: z.string() }).nullable(),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
})

export type Repository = z.infer<typeof repository>

const branch = z.object({ name: z.string() })

const pullRequestView = z.object({
  url: z.string(),
  title: z.string(),
  body: z.string().nullish().default(''),
  isDraft: z.boolean(),
  state: z.enum(['OPEN', 'MERGED', 'CLOSED', 'open', 'merged', 'closed']),
  mergeable: z.enum(['MERGEABLE', 'CONFLICTING', 'UNKNOWN']).nullish(),
})

export type PullRequestView = {
  url: string
  title: string
  body: string
  isDraft: boolean
  state: 'open' | 'merged' | 'closed'
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null
}

function toPullRequestView(raw: {
  url: string
  title: string
  body?: string | null | undefined
  isDraft: boolean
  state: string
  mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null | undefined
}): PullRequestView {
  const state = raw.state.toLowerCase()
  return {
    url: raw.url,
    title: raw.title,
    body: raw.body ?? '',
    isDraft: raw.isDraft,
    state: state === 'merged' || state === 'closed' ? state : 'open',
    mergeable: raw.mergeable ?? null,
  }
}

export interface GitHubClientOptions {
  /** Path to the CLI. Overridable for tests and unusual installs. */
  binary?: string
  /** Injectable so tests never shell out. */
  run?: (args: string[]) => Promise<string>
}

export class GitHubClient {
  private readonly binary: string
  private readonly run: (args: string[]) => Promise<string>

  constructor(options: GitHubClientOptions = {}) {
    this.binary = options.binary ?? 'gh'
    this.run = options.run ?? ((args) => this.execute(args))
  }

  private async execute(args: string[]): Promise<string> {
    try {
      const { stdout } = await exec(this.binary, args, {
        // A repository list can exceed the default buffer.
        maxBuffer: 10 * 1024 * 1024,
      })
      return stdout
    } catch (error) {
      const failure = error as { code?: string; stderr?: string; message?: string }

      if (failure.code === 'ENOENT') {
        throw new GitHubError(
          'the gh command was not found',
          'Install the GitHub CLI: https://cli.github.com',
        )
      }

      const stderr = failure.stderr ?? failure.message ?? 'unknown error'

      // The one failure an operator can always fix themselves, and the one
      // they hit first after a fresh install.
      if (/not logged|authentication|gh auth login/i.test(stderr)) {
        throw new GitHubError('gh is not authenticated', 'Run: gh auth login')
      }

      throw new GitHubError(`gh ${args[0] ?? ''} failed: ${stderr.trim()}`)
    }
  }

  private async json<T>(args: string[], schema: z.ZodType<T>): Promise<T> {
    const raw = await this.run(args)

    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      throw new GitHubError(`gh ${args[0] ?? ''} returned output that is not JSON`)
    }

    const result = schema.safeParse(parsed)
    if (!result.success) {
      throw new GitHubError(`unexpected gh output: ${result.error.message}`)
    }

    return result.data
  }

  /**
   * The token `gh` holds.
   *
   * Read on demand by the credential proxy rather than cached, so it is never
   * held longer than an in-flight request and a re-login takes effect at once.
   */
  async token(): Promise<string> {
    const token = (await this.run(['auth', 'token'])).trim()
    if (!token) throw new GitHubError('gh returned an empty token', 'Run: gh auth login')
    return token
  }

  /** Whether `gh` is installed and signed in. Used by preflight checks. */
  async isAuthenticated(): Promise<boolean> {
    try {
      await this.run(['auth', 'status'])
      return true
    } catch {
      return false
    }
  }

  /** The signed-in account. */
  async currentUser(): Promise<string> {
    const user = await this.json(
      ['api', 'user', '--jq', '{login: .login}'],
      z.object({ login: z.string() }),
    )
    return user.login
  }

  /** Repositories the user can push to, most recently updated first. */
  async listRepositories(limit = 100): Promise<Repository[]> {
    return this.json(
      [
        'repo',
        'list',
        '--limit',
        String(limit),
        '--json',
        'nameWithOwner,defaultBranchRef,isPrivate,updatedAt',
      ],
      z.array(repository),
    )
  }

  /** Branch names in a repository. */
  async listBranches(repoFullName: string, limit = 100): Promise<string[]> {
    const branches = await this.json(
      ['api', `repos/${repoFullName}/branches?per_page=${limit}`, '--jq', '[.[] | {name}]'],
      z.array(branch),
    )

    return branches.map((entry) => entry.name)
  }

  /** A repository's default branch, which is the base for new sessions. */
  async defaultBranch(repoFullName: string): Promise<string> {
    const repo = await this.json(
      ['api', `repos/${repoFullName}`, '--jq', '{name: .default_branch}'],
      z.object({ name: z.string() }),
    )

    return repo.name
  }

  /**
   * Open a pull request and return its URL.
   *
   * Draft by default: the agent is still working, and a ready PR would invite
   * review of unfinished work. Pass `draft: false` when the caller has already
   * decided it is ready.
   */
  async createPullRequest(options: {
    repoFullName: string
    head: string
    base: string
    title: string
    body?: string
    draft?: boolean
  }): Promise<string> {
    const args = [
      'pr',
      'create',
      '--repo',
      options.repoFullName,
      '--head',
      options.head,
      '--base',
      options.base,
      '--title',
      options.title,
      // Always passed, even when empty: without it `gh` opens an editor and
      // waits forever on a headless server.
      '--body',
      options.body ?? '',
    ]

    if (options.draft !== false) args.push('--draft')

    const output = (await this.run(args)).trim()

    // `gh pr create` prints the URL as its last line.
    const url = output.split('\n').filter(Boolean).at(-1) ?? ''
    if (!url.startsWith('https://')) {
      throw new GitHubError(`could not read the pull request URL from: ${output}`)
    }

    return url
  }

  /** An open or recently closed pull request for a branch, or null. */
  async findPullRequest(repoFullName: string, head: string): Promise<PullRequestView | null> {
    const results = await this.json(
      [
        'pr',
        'list',
        '--repo',
        repoFullName,
        '--head',
        head,
        '--json',
        'url,title,body,isDraft,state,mergeable',
        '--state',
        'all',
        '--limit',
        '1',
      ],
      z.array(pullRequestView),
    )

    const first = results[0]
    return first ? toPullRequestView(first) : null
  }

  /** One pull request, identified by URL. */
  async viewPullRequest(repoFullName: string, url: string): Promise<PullRequestView> {
    const raw = await this.json(
      [
        'pr',
        'view',
        url,
        '--repo',
        repoFullName,
        '--json',
        'url,title,body,isDraft,state,mergeable',
      ],
      pullRequestView,
    )

    return toPullRequestView(raw)
  }

  /** Mark a draft pull request ready for review. */
  async markReady(repoFullName: string, url: string): Promise<void> {
    await this.run(['pr', 'ready', url, '--repo', repoFullName])
  }

  /** Merge a pull request. */
  async mergePullRequest(options: {
    repoFullName: string
    url: string
    method: 'squash' | 'merge' | 'rebase'
    deleteBranch?: boolean
  }): Promise<void> {
    const args = ['pr', 'merge', options.url, '--repo', options.repoFullName, `--${options.method}`]
    if (options.deleteBranch) args.push('--delete-branch')
    await this.run(args)
  }

  /** Update a pull request's title or body. */
  async editPullRequest(options: {
    repoFullName: string
    url: string
    title?: string
    body?: string
  }): Promise<void> {
    const args = ['pr', 'edit', options.url, '--repo', options.repoFullName]
    if (options.title !== undefined) args.push('--title', options.title)
    if (options.body !== undefined) args.push('--body', options.body)
    await this.run(args)
  }
}
